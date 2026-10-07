import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ResultSchema,
  type CallToolRequest,
  type ListToolsResult,
  type Request,
  type ServerCapabilities,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import { desktopCommand, safeEnvironment } from "./connector-process.js";
import {
  createConnectorWatchdog,
  type ConnectorBackendState,
  type ConnectorWatchdog,
} from "./connector-watchdog.js";

const CLOSE_TIMEOUT_MS = 1_500;
const CONNECT_TIMEOUT_MS = 15_000;
const INITIAL_READINESS_TIMEOUT_MS = 5_000;

export interface DesktopCommanderTiming {
  initialReadinessTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatFailureThreshold?: number;
}

export interface DesktopCommanderSnapshot {
  ready: boolean;
  state: ConnectorBackendState;
  lastBackendOkAt?: string;
  consecutiveMisses: number;
  pid?: number;
  processStartedAt?: string;
  activeRequestCount: number;
  notificationCounts: Record<string, number>;
  recentRequests: Array<{
    timestamp: string;
    method: string;
    durationMs: number;
    status: "ok" | "error";
  }>;
}

export interface DesktopCommanderIntegrationOptions {
  root: string;
  timing?: DesktopCommanderTiming;
  onDisconnect?: (reason: string) => void;
  onDiagnostic?: (event: { method: string; message: string }) => void;
}

export class DesktopCommanderIntegration {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private watchdog: ConnectorWatchdog | undefined;
  private closing = false;
  private readyValue = false;
  private disconnectReported = false;
  private closePromise: Promise<void> | undefined;
  private disconnectHandler: ((reason: string) => void) | undefined;
  private processPid: number | undefined;
  private processStartedAt: string | undefined;
  private activeRequestCount = 0;
  private readonly notificationCounts: Record<string, number> = {};
  private readonly recentRequests: DesktopCommanderSnapshot["recentRequests"] = [];

  constructor(private readonly options: DesktopCommanderIntegrationOptions) {
    this.disconnectHandler = options.onDisconnect;
  }

  get ready(): boolean {
    return this.readyValue && !!this.client && !this.closing;
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  async initialize(): Promise<void> {
    if (this.closing) throw new Error("Desktop Commander integration is closing.");
    if (this.ready) return;
    if (this.client || this.transport)
      throw new Error("Desktop Commander initialization is already in progress.");

    const command = desktopCommand(this.options.root);
    const transport = new StdioClientTransport({
      command: command.file,
      args: command.args,
      env: {
        ...safeEnvironment(process.env),
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1",
        DC_REMOTE_DEVICE: "true",
      } as Record<string, string>,
      stderr: "ignore",
      cwd: this.options.root,
    });
    const client = new Client(
      { name: "desktop-commander-client", version: "1.0.0" },
      { capabilities: {} },
    );
    this.transport = transport;
    this.client = client;
    this.processStartedAt = new Date().toISOString();

    client.onerror = (error) => {
      this.options.onDiagnostic?.({
        method: "mcp-client-error",
        message: error.name.slice(0, 80),
      });
    };
    client.fallbackNotificationHandler = async (notification) => {
      const method = notification.method;
      this.notificationCounts[method] = (this.notificationCounts[method] ?? 0) + 1;
    };

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      this.processPid = transport.pid ?? undefined;
      client.onclose = () => this.handleDisconnect("stdio transport closed");

      // Upstream defines readiness as a real execution request after connect.
      await this.runRequest("tools/list", () =>
        client.listTools(undefined, {
          timeout:
            this.options.timing?.initialReadinessTimeoutMs ??
            INITIAL_READINESS_TIMEOUT_MS,
        }),
      );
      if (this.closing) throw new Error("Desktop Commander integration is closing.");

      this.readyValue = true;
      this.watchdog = createConnectorWatchdog({
        ping: async (timeoutMs) => {
          await this.ping(timeoutMs);
        },
        onFailure: () => this.handleDisconnect("watchdog missed heartbeat threshold"),
        initialSuccessAt: Date.now(),
        ...(this.options.timing?.heartbeatIntervalMs !== undefined
          ? { intervalMs: this.options.timing.heartbeatIntervalMs }
          : {}),
        ...(this.options.timing?.heartbeatTimeoutMs !== undefined
          ? { timeoutMs: this.options.timing.heartbeatTimeoutMs }
          : {}),
        ...(this.options.timing?.heartbeatFailureThreshold !== undefined
          ? { failureThreshold: this.options.timing.heartbeatFailureThreshold }
          : {}),
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  getServerInfo(): {
    version?: Implementation;
    capabilities?: ServerCapabilities;
    instructions?: string;
  } {
    const version = this.client?.getServerVersion();
    const capabilities = this.client?.getServerCapabilities();
    const instructions = this.client?.getInstructions();
    return {
      ...(version ? { version } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(instructions ? { instructions } : {}),
    };
  }

  listTools(options?: RequestOptions): Promise<ListToolsResult> {
    return this.runRequest("tools/list", () => this.requireClient().listTools(undefined, options));
  }

  callTool(
    params: CallToolRequest["params"],
    options?: RequestOptions,
  ): Promise<any> {
    const metadata = params._meta && typeof params._meta === "object" ? params._meta : {};
    return this.runRequest("tools/call", () =>
      this.requireClient().callTool(
        {
          ...params,
          _meta: { ...metadata, remote: true },
        },
        undefined,
        options,
      ),
    );
  }

  ping(
    timeoutMs: number,
    options?: RequestOptions,
  ): Promise<Awaited<ReturnType<Client["ping"]>>> {
    return this.runRequest("ping", () =>
      this.requireClient().ping({ ...options, timeout: timeoutMs }),
    );
  }

  notification(notification: Parameters<Client["notification"]>[0]): Promise<void> {
    return this.requireClient().notification(notification);
  }

  request(
    request: Request,
    options?: RequestOptions,
  ): Promise<any> {
    return this.runRequest(request.method, () =>
      this.requireClient().request(request, ResultSchema, options),
    );
  }

  snapshot(): DesktopCommanderSnapshot {
    const heartbeat = this.watchdog?.snapshot();
    return {
      ready: this.ready,
      state: heartbeat?.state ?? "unknown",
      ...(heartbeat?.lastBackendOkAt
        ? { lastBackendOkAt: heartbeat.lastBackendOkAt }
        : {}),
      consecutiveMisses: heartbeat?.consecutiveMisses ?? 0,
      ...(this.processPid ? { pid: this.processPid } : {}),
      ...(this.processStartedAt ? { processStartedAt: this.processStartedAt } : {}),
      activeRequestCount: this.activeRequestCount,
      notificationCounts: { ...this.notificationCounts },
      recentRequests: this.recentRequests.map((event) => ({ ...event })),
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.readyValue = false;
    this.closePromise = (async () => {
      await this.watchdog?.stop();
      this.watchdog = undefined;
      const client = this.client;
      const transport = this.transport;
      this.client = undefined;
      this.transport = undefined;
      await settleWithin(
        Promise.allSettled([
          client?.close() ?? Promise.resolve(),
          transport?.close() ?? Promise.resolve(),
        ]),
        CLOSE_TIMEOUT_MS,
      );
    })();
    return this.closePromise;
  }

  private requireClient(): Client {
    if (!this.ready || !this.client)
      throw new Error("Desktop Commander integration is not ready.");
    return this.client;
  }

  private handleDisconnect(reason: string): void {
    if (this.closing || this.disconnectReported) return;
    this.readyValue = false;
    this.disconnectReported = true;
    this.disconnectHandler?.(reason);
  }

  private async runRequest<T>(method: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    this.activeRequestCount++;
    let status: "ok" | "error" = "ok";
    try {
      return await operation();
    } catch (error) {
      status = "error";
      throw error;
    } finally {
      this.activeRequestCount--;
      this.recentRequests.push({
        timestamp: new Date(startedAt).toISOString(),
        method,
        durationMs: Date.now() - startedAt,
        status,
      });
      if (this.recentRequests.length > 50) this.recentRequests.shift();
    }
  }
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
