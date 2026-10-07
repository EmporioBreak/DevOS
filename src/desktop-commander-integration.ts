import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ResultSchema,
  ErrorCode,
  type CallToolRequest,
  type ListToolsResult,
  type Request,
  type ServerCapabilities,
  type Implementation,
} from "@modelcontextprotocol/sdk/types.js";
import {
  captureProcessUsage,
  desktopCommand,
  safeEnvironment,
  type ProcessUsage,
} from "./connector-process.js";
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
  protocolErrorCount: number;
  rssBytes?: number;
  cpuPercent?: number;
  notificationCounts: Record<string, number>;
  recentRequests: Array<{
    timestamp: string;
    method: string;
    durationMs: number;
    status: "ok" | "error" | "timeout" | "cancelled";
  }>;
}

export interface DesktopCommanderIntegrationOptions {
  root: string;
  timing?: DesktopCommanderTiming;
  onDisconnect?: (reason: string) => void;
  onDiagnostic?: (event: {
    method: string;
    message: string;
    snapshot: DesktopCommanderSnapshot;
  }) => void | Promise<void>;
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
  private protocolErrorCount = 0;
  private processUsage: ProcessUsage | undefined;
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
    client.onerror = () => {
      this.protocolErrorCount++;
    };
    client.fallbackNotificationHandler = async (notification) => {
      this.recordNotification(notification.method);
    };

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      this.processPid = transport.pid ?? undefined;
      this.processStartedAt = new Date().toISOString();
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
    return this.runRequest(
      "tools/list",
      () => this.requireClient().listTools(undefined, options),
      options,
    );
  }

  callTool(
    params: CallToolRequest["params"],
    options?: RequestOptions,
  ): Promise<any> {
    return this.runRequest(
      "tools/call",
      () => this.requireClient().callTool(
        {
          ...params,
          _meta: safeRemoteMetadata(params._meta),
        },
        undefined,
        options,
      ),
      options,
    );
  }

  ping(
    timeoutMs: number,
    options?: RequestOptions,
  ): Promise<Awaited<ReturnType<Client["ping"]>>> {
    return this.runRequest(
      "ping",
      () => this.requireClient().ping({ ...options, timeout: timeoutMs }),
      options,
    );
  }

  notification(notification: Parameters<Client["notification"]>[0]): Promise<void> {
    return this.requireClient().notification(notification);
  }

  request(
    request: Request,
    options?: RequestOptions,
  ): Promise<any> {
    return this.runRequest(
      request.method,
      () => this.requireClient().request(request, ResultSchema, options),
      options,
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
      ...(this.processUsage ? this.processUsage : {}),
      activeRequestCount: this.activeRequestCount,
      protocolErrorCount: this.protocolErrorCount,
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
    this.processUsage = this.processPid ? captureProcessUsage(this.processPid) : undefined;
    void Promise.resolve(
      this.options.onDiagnostic?.({
        method: "disconnect",
        message: reason.slice(0, 100),
        snapshot: this.snapshot(),
      }),
    ).catch(() => {});
    this.disconnectHandler?.(reason);
  }

  private async runRequest<T>(
    method: string,
    operation: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T> {
    const startedAt = Date.now();
    this.activeRequestCount++;
    let status: "ok" | "error" | "timeout" | "cancelled" = "ok";
    try {
      return await operation();
    } catch (error) {
      status = options?.signal?.aborted
        ? "cancelled"
        : isTimeoutError(error)
          ? "timeout"
          : "error";
      throw error;
    } finally {
      this.activeRequestCount--;
      this.recentRequests.push({
        timestamp: new Date(startedAt).toISOString(),
        method: method.slice(0, 80),
        durationMs: Date.now() - startedAt,
        status,
      });
      if (this.recentRequests.length > 50) this.recentRequests.shift();
    }
  }

  private recordNotification(method: string): void {
    const boundedMethod = method.slice(0, 80);
    const key =
      Object.hasOwn(this.notificationCounts, boundedMethod) ||
      Object.keys(this.notificationCounts).length < 16
        ? boundedMethod
        : "other";
    this.notificationCounts[key] = (this.notificationCounts[key] ?? 0) + 1;
  }
}

function isTimeoutError(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    "code" in error && error.code === ErrorCode.RequestTimeout;
}

function safeRemoteMetadata(value: unknown): Record<string, unknown> {
  const input = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const metadata: Record<string, unknown> = { remote: true };
  const token = input.progressToken;
  if (
    (typeof token === "string" && token.length <= 256) ||
    (typeof token === "number" && Number.isFinite(token))
  ) metadata.progressToken = token;

  const clientInfo = input.clientInfo;
  if (clientInfo && typeof clientInfo === "object" && !Array.isArray(clientInfo)) {
    const info = clientInfo as Record<string, unknown>;
    const safeInfo: Record<string, string> = {};
    for (const field of ["name", "version"] as const) {
      const fieldValue = info[field];
      if (typeof fieldValue === "string" && fieldValue.length <= 100)
        safeInfo[field] = fieldValue;
    }
    if (Object.keys(safeInfo).length) metadata.clientInfo = safeInfo;
  }
  return metadata;
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
