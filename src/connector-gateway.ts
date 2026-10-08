import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectorAuth } from "./connector-auth.js";
import { DesktopCommanderIntegration, type DesktopCommanderSnapshot } from "./desktop-commander-integration.js";
import { appendDesktopCommanderDiagnostic } from "./connector-diagnostics.js";
import {
  CHAT_BINDING_ARGUMENT,
  addChatBindingTokenToTool,
  createChatBindingToken,
  stripChatBindingTokenFromCall,
} from "./chat-binding-protocol.js";

export function publicIdentity(value: string): URL {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error();
    return u;
  } catch {
    throw new Error(
      "Invalid public HTTPS origin; credentials, query and paths are forbidden.",
    );
  }
}
export function ownerAuth(secret: string | undefined): string {
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    Buffer.byteLength(secret) > 1024
  )
    throw new Error(
      "Missing/weak owner authentication: set DEVOS_CONNECTOR_OWNER_SECRET (at least 32 bytes).",
    );
  return secret;
}

function withOpenAiSecuritySchemes(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const envelope = message as {
    result?: { tools?: Array<Record<string, unknown>> };
    [key: string]: unknown;
  };
  if (!Array.isArray(envelope.result?.tools)) return message;
  return {
    ...envelope,
    result: {
      ...envelope.result,
      tools: envelope.result.tools.map((tool) => ({
        ...tool,
        securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
        _meta: {
          ...((tool._meta && typeof tool._meta === "object"
            ? tool._meta
            : {}) as Record<string, unknown>),
          securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
        },
      })),
    },
  };
}

/**
 * The v1 MCP SDK validates tools/list against the 2025 schema and strips the
 * newer top-level securitySchemes field before serialization. ChatGPT's
 * current plugin scanner expects the modern field, while still accepting the
 * _meta mirror for compatibility. Patch only serialized tools/list envelopes
 * so the local provider-neutral Desktop Commander can stay on its pinned v1
 * stdio protocol.
 */
export function patchToolListWireBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  try {
    return JSON.stringify(withOpenAiSecuritySchemes(JSON.parse(trimmed)));
  } catch {
    // Streamable HTTP commonly frames a JSON-RPC result as SSE. Rewrite only
    // data lines that contain a complete JSON object and preserve the framing.
    return body
      .split("\n")
      .map((line) => {
        if (!line.startsWith("data:")) return line;
        const payload = line.slice(5).trimStart();
        try {
          return "data: " + JSON.stringify(withOpenAiSecuritySchemes(JSON.parse(payload)));
        } catch {
          return line;
        }
      })
      .join("\n");
  }
}

function chatGptCompatibleTool(tool: Record<string, unknown>) {
  const name = String(tool.name ?? "");
  const next = { ...tool };

  if (name === "set_config_value") {
    next.description =
      String(tool.description ?? "") +
      "\n\nChatGPT compatibility: pass value_json as a JSON-encoded value (for example true, 100, null, \"/bin/zsh\", or [\"/Users/me/Documents\"]).";
    next.inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        key: { type: "string" },
        value_json: {
          type: "string",
          description: "JSON-encoded configuration value.",
        },
      },
      required: ["key", "value_json"],
      additionalProperties: false,
    };
  }

  if (name === "write_pdf") {
    next.description =
      String(tool.description ?? "") +
      "\n\nChatGPT compatibility: content is always a string. Use content_format=markdown to create a PDF, or content_format=operations_json with a JSON-encoded array of insert/delete operations to modify one. Pass free-form PDF options through options_json when needed.";
    next.inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        content_format: {
          type: "string",
          enum: ["markdown", "operations_json"],
        },
        outputPath: { type: "string" },
        options_json: {
          type: "string",
          description: "Optional JSON-encoded PDF options object.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    };
  }

  if (name === "edit_block") {
    next.description =
      String(tool.description ?? "") +
      "\n\nChatGPT compatibility: text/DOCX edits use old_string/new_string normally. Excel range edits pass the 2D cell array as JSON in content_json. Pass free-form options through options_json when needed.";
    next.inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        expected_replacements: { type: "number" },
        range: { type: "string" },
        content_json: {
          type: "string",
          description: "JSON-encoded 2D cell array for Excel range edits.",
        },
        options_json: {
          type: "string",
          description: "Optional JSON-encoded options object.",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    };
  }

  return next;
}

export function adaptChatGptToolCall(request: unknown): unknown {
  if (!request || typeof request !== "object") return request;
  const call = request as {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown>; [key: string]: unknown };
    [key: string]: unknown;
  };
  if (call.method !== "tools/call" || !call.params?.arguments) return request;

  const name = String(call.params.name ?? "");
  const args = { ...call.params.arguments };

  if (name === "set_config_value" && typeof args.value_json === "string") {
    args.value = JSON.parse(args.value_json);
    delete args.value_json;
  }

  if (name === "write_pdf") {
    if (args.content_format === "operations_json" && typeof args.content === "string") {
      args.content = JSON.parse(args.content);
    }
    delete args.content_format;
    if (typeof args.options_json === "string") {
      args.options = JSON.parse(args.options_json);
    }
    delete args.options_json;
  }

  if (name === "edit_block") {
    if (typeof args.content_json === "string") {
      args.content = JSON.parse(args.content_json);
    }
    delete args.content_json;
    if (typeof args.options_json === "string") {
      args.options = JSON.parse(args.options_json);
    }
    delete args.options_json;
  }

  return {
    ...call,
    params: {
      ...call.params,
      arguments: args,
    },
  };
}

export const CONNECTOR_REQUEST_TIMEOUTS = {
  serviceMs: 60_000,
  toolIdleMs: 60_000,
  toolTotalMs: 180_000,
} as const;

const MAX_PUBLIC_MCP_SESSIONS = 32;
const MCP_SESSION_EVICTION_CLOSE_TIMEOUT_MS = 1_000;

interface PublicMcpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  clientId: string;
  activeRequestCount: number;
  lastActivityAt: number;
  bindingToken?: string;
  bindingScheduled: boolean;
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

async function evictLeastRecentlyUsedIdleSession(
  sessions: Map<string, PublicMcpSession>,
): Promise<boolean> {
  let candidate: [string, PublicMcpSession] | undefined;
  for (const entry of sessions) {
    const [, session] = entry;
    if (
      session.activeRequestCount === 0 &&
      (!candidate || session.lastActivityAt < candidate[1].lastActivityAt)
    ) candidate = entry;
  }
  if (!candidate) return false;

  // Forget the session before closing it so new requests fail closed while
  // transport cleanup settles. The client can initialize a fresh session.
  sessions.delete(candidate[0]);
  await settleWithin(
    candidate[1].server.close(),
    MCP_SESSION_EVICTION_CLOSE_TIMEOUT_MS,
  );
  return true;
}

export async function startGateway(options: {
  root: string;
  port: number;
  ownerSecret: string;
  publicUrl?: string;
  oauthClientsPath?: string | null;
  oauthStatePath?: string | null;
  onFailure?: (component: "desktop_commander") => void;
  onDiagnostic?: (record: {
    reason: string;
    runtimePid: number;
    publicSessionCount: number;
    activeForwardedRequestCount: number;
    snapshot: DesktopCommanderSnapshot;
  }) => void | Promise<void>;
  timing?: {
    initialReadinessTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatFailureThreshold?: number;
  };
  requestTimeouts?: Partial<{
    serviceMs: number;
    toolIdleMs: number;
    toolTotalMs: number;
  }>;
  onBindingTokenSeen?: (token: string) => void | Promise<void>;
}) {
  ownerAuth(options.ownerSecret);
  let identity = options.publicUrl
    ? publicIdentity(options.publicUrl)
    : undefined;
  const app = express();
  app.disable("x-powered-by");
  // Do not trust forwarded host/proto/header values as an OAuth issuer.
  app.use((req, res, next) => {
    if (
      identity &&
      req.headers.origin &&
      req.headers.origin !== identity.origin
    ) {
      res.status(403).json({ error: "forbidden_origin" });
      return;
    }
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
  let closing = false;
  let failureReported = false;
  let closingPromise: Promise<void> | undefined;
  const activeRequests = new Set<AbortController>();
  const forwardedRequests = new Set<Promise<unknown>>();
  const diagnosticWrites = new Set<Promise<unknown>>();
  const sessions = new Map<string, PublicMcpSession>();
  let pendingSessionInitializations = 0;
  const reportFailure = () => {
    if (closing || failureReported) return;
    failureReported = true;
    options.onFailure?.("desktop_commander");
  };
  let desktop: DesktopCommanderIntegration;
  desktop = new DesktopCommanderIntegration({
    root: options.root,
    ...(options.timing ? { timing: options.timing } : {}),
    onDisconnect: reportFailure,
    onDiagnostic: (event) => {
      if (event.method !== "disconnect") return;
      const write = Promise.resolve(options.onDiagnostic?.({
        reason: event.message,
        runtimePid: process.pid,
        publicSessionCount: sessions.size,
        activeForwardedRequestCount: forwardedRequests.size,
        snapshot: event.snapshot,
      })).catch(() => {}).finally(() => diagnosticWrites.delete(write));
      diagnosticWrites.add(write);
    },
  });
  try {
    await desktop.initialize();
  } catch {
    closing = true;
    throw Object.assign(
      new Error("Local Desktop Commander initialization or readiness proof failed."),
      { component: "desktop_commander" },
    );
  }
  let authRouter: express.RequestHandler | undefined;
  let bearer: express.RequestHandler | undefined;
  let provider: ConnectorAuth | undefined;
  function setPublicUrl(value: string) {
    if (identity && provider)
      throw new Error("Public identity already configured.");
    identity = publicIdentity(value);
    const resource = new URL("/mcp", identity);
    provider = new ConnectorAuth(
      resource,
      options.ownerSecret,
      options.oauthClientsPath === null
        ? undefined
        : options.oauthClientsPath ??
            join(options.root, ".devos", "connector", "oauth-clients.json"),
      options.oauthStatePath === null ? undefined : options.oauthStatePath,
    );
    authRouter = mcpAuthRouter({
      provider,
      issuerUrl: identity,
      resourceServerUrl: resource,
      scopesSupported: ["mcp:tools", "offline_access"],
      resourceName: "DevOS Desktop Commander",
    });
    bearer = requireBearerAuth({
      verifier: provider,
      requiredScopes: ["mcp:tools"],
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
      expectedResource: resource,
    });
  }
  if (identity) setPublicUrl(identity.href);
  app.get("/health", (_req, res) => {
    const backend = desktop.snapshot();
    const gatewayReady = desktop.ready;
    const backendAlive = backend?.state === "alive";
    const oauthReady = !!provider;
    res.json({
      ready: gatewayReady && oauthReady && backendAlive,
      gatewayReady,
      oauthReady,
      backendAlive,
      backendState: backend.state,
      lastBackendOkAt: backend.lastBackendOkAt ?? null,
    });
  });

  // ChatGPT performs a post-OAuth action-discovery probe against the public
  // origin itself (POST /), not only the configured /mcp resource path.
  // Returning an arbitrary 404/HTML/JSON payload makes the connector fail
  // with MCP_ACTION_DISCOVERY_FAILED even though OAuth succeeded. Handle that
  // probe with a valid JSON-RPC 2.0 error envelope. This route exposes no
  // tools, accepts no credentials, and does not weaken bearer auth on /mcp.
  app.post(
    "/",
    express.json({ limit: "16kb" }),
    (req, res) => {
      const requestId =
        req.body &&
        typeof req.body === "object" &&
        !Array.isArray(req.body) &&
        "id" in req.body
          ? req.body.id
          : null;
      res.status(200).json({
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32600, message: "Invalid Request" },
      });
    },
  );

  app.use((req, res, next) => {
    if (!authRouter) {
      res.status(503).json({ error: "connector_not_ready" });
      return;
    }
    authRouter(req, res, next);
  });
  app.post(
    "/consent",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 20,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    express.urlencoded({ extended: false, limit: "8kb" }),
    (req, res) => {
      if (req.headers.origin !== identity!.origin) {
        res.status(403).json({ error: "access_denied" });
        return;
      }
      provider!.consent(req.body.ticket, req.body.secret, res);
    },
  );
  app.all(
    ["/mcp", "/"],
    (req, res, next) => bearer!(req, res, next),
    express.json({ limit: "1mb" }),
    async (req, res) => {
      let releaseSessionReservation: (() => void) | undefined;
      try {
        const id = req.headers["mcp-session-id"];
        let session = typeof id === "string" ? sessions.get(id) : undefined;
        if (id && !session) {
          res.status(404).json({ error: "unknown_session" });
          return;
        }
        if (session && session.clientId !== req.auth!.clientId) {
          res.status(403).json({ error: "session_owner_mismatch" });
          return;
        }
        if (!session) {
          if (req.method !== "POST" || !isInitializeRequest(req.body)) {
            res.status(400).json({ error: "initialize_required" });
            return;
          }
          if (sessions.size + pendingSessionInitializations >= MAX_PUBLIC_MCP_SESSIONS) {
            await evictLeastRecentlyUsedIdleSession(sessions);
            if (sessions.size + pendingSessionInitializations >= MAX_PUBLIC_MCP_SESSIONS) {
              res.status(503).json({ error: "session_capacity" });
              return;
            }
          }
          pendingSessionInitializations++;
          let reservationPending = true;
          releaseSessionReservation = () => {
            if (!reservationPending) return;
            reservationPending = false;
            pendingSessionInitializations--;
          };
          const localInfo = desktop.getServerInfo();
          const bindingToken = options.onBindingTokenSeen
            ? createChatBindingToken()
            : undefined;
          let newSession: PublicMcpSession | undefined;
          const server = new Server(
            localInfo.version ?? {
              name: "desktop-commander",
              version: "0.2.52",
            },
            {
              capabilities: localInfo.capabilities ?? {},
              ...(localInfo.instructions
                ? { instructions: localInfo.instructions }
                : {}),
            },
          );
          server.onerror = () => {};
          server.fallbackRequestHandler = async (request, extra) => {
            const token = (
              request.params?._meta as
                | { progressToken?: string | number }
                | undefined
            )?.progressToken;
            const writes: Promise<void>[] = [];
            const toolCall = request.method === "tools/call";
            const bindingEvidence =
              toolCall &&
              !!bindingToken &&
              request.params?.arguments &&
              typeof request.params.arguments === "object" &&
              (request.params.arguments as Record<string, unknown>)[CHAT_BINDING_ARGUMENT] === bindingToken;
            const bindingAwareRequest = bindingToken
              ? stripChatBindingTokenFromCall(request, bindingToken)
              : request;
            const forwardedRequest = adaptChatGptToolCall(bindingAwareRequest) as typeof request;
            if (
              bindingEvidence &&
              bindingToken &&
              newSession &&
              !newSession.bindingScheduled
            ) {
              newSession.bindingScheduled = true;
              void Promise.resolve(options.onBindingTokenSeen?.(bindingToken)).catch(() => {});
            }
            const timeoutOptions = toolCall
              ? {
                  timeout:
                    options.requestTimeouts?.toolIdleMs ??
                    CONNECTOR_REQUEST_TIMEOUTS.toolIdleMs,
                  resetTimeoutOnProgress: true,
                  maxTotalTimeout:
                    options.requestTimeouts?.toolTotalMs ??
                    CONNECTOR_REQUEST_TIMEOUTS.toolTotalMs,
                }
              : {
                  timeout:
                    options.requestTimeouts?.serviceMs ??
                    CONNECTOR_REQUEST_TIMEOUTS.serviceMs,
                  maxTotalTimeout:
                    options.requestTimeouts?.serviceMs ??
                    CONNECTOR_REQUEST_TIMEOUTS.serviceMs,
                };
            let result: any;
            const requestController = new AbortController();
            const abortFromClient = () =>
              requestController.abort(extra.signal.reason);
            if (extra.signal.aborted) abortFromClient();
            else extra.signal.addEventListener("abort", abortFromClient, { once: true });
            activeRequests.add(requestController);
            let forwardedRequestPromise: Promise<any> | undefined;
            try {
              const forwardOptions = {
                signal: requestController.signal,
                ...timeoutOptions,
                ...(token !== undefined || toolCall
                  ? {
                      onprogress: (progress: {
                        progress: number;
                        total?: number | undefined;
                        message?: string | undefined;
                      }) => {
                        if (token === undefined) return;
                        writes.push(
                          extra.sendNotification({
                            method: "notifications/progress",
                            params: { ...progress, progressToken: token },
                          }),
                        );
                      },
                    }
                  : {}),
              };
              if (forwardedRequest.method === "tools/list") {
                forwardedRequestPromise = desktop.listTools(forwardOptions);
              } else if (forwardedRequest.method === "tools/call") {
                if (!forwardedRequest.params || typeof forwardedRequest.params.name !== "string")
                  throw new Error("Invalid tools/call request.");
                forwardedRequestPromise = desktop.callTool(
                  forwardedRequest.params as Parameters<DesktopCommanderIntegration["callTool"]>[0],
                  forwardOptions,
                );
              } else if (forwardedRequest.method === "ping") {
                forwardedRequestPromise = desktop.ping(
                  options.requestTimeouts?.serviceMs ??
                    CONNECTOR_REQUEST_TIMEOUTS.serviceMs,
                  forwardOptions,
                );
              } else {
                forwardedRequestPromise = desktop.request(
                  forwardedRequest,
                  forwardOptions,
                );
              }
              forwardedRequests.add(forwardedRequestPromise);
              result = await forwardedRequestPromise;
            } catch (error) {
              void Promise.allSettled(writes);
              throw error;
            } finally {
              activeRequests.delete(requestController);
              extra.signal.removeEventListener("abort", abortFromClient);
              if (forwardedRequestPromise)
                forwardedRequests.delete(forwardedRequestPromise);
            }
            await Promise.all(writes);

            // ChatGPT imports remote MCP actions from tools/list and expects each
            // authenticated tool to advertise its OAuth policy explicitly. The
            // local Desktop Commander is a provider-neutral stdio server and has
            // no knowledge of the public gateway's OAuth scope, so add that policy
            // only at this remote boundary without changing the upstream tool.
            if (
              request.method === "tools/list" &&
              result &&
              typeof result === "object" &&
              Array.isArray((result as { tools?: unknown[] }).tools)
            ) {
              const listed = result as {
                tools: Array<Record<string, unknown>>;
                [key: string]: unknown;
              };
              const excludedForChatGpt = new Set(["track_ui_event"]);
              return {
                ...listed,
                tools: listed.tools
                  .filter(
                    (tool) => !excludedForChatGpt.has(String(tool.name ?? "")),
                  )
                  .map((tool) => {
                    const compatibleTool = chatGptCompatibleTool(tool);
                    const annotations =
                      compatibleTool.annotations &&
                      typeof compatibleTool.annotations === "object"
                        ? (compatibleTool.annotations as Record<string, unknown>)
                        : {};
                    const readOnly = annotations.readOnlyHint === true;
                    const title =
                      typeof compatibleTool.title === "string"
                        ? compatibleTool.title
                        : typeof annotations.title === "string"
                          ? annotations.title
                          : String(
                              compatibleTool.name ?? "Desktop Commander tool",
                            );
                    const inputSchema =
                      compatibleTool.inputSchema &&
                      typeof compatibleTool.inputSchema === "object"
                        ? structuredClone(
                            compatibleTool.inputSchema as Record<string, unknown>,
                          )
                        : compatibleTool.inputSchema;
                    if (
                      inputSchema &&
                      typeof inputSchema === "object" &&
                      "properties" in inputSchema &&
                      inputSchema.properties &&
                      typeof inputSchema.properties === "object"
                    ) {
                      const properties = inputSchema.properties as Record<
                        string,
                        unknown
                      >;
                      delete properties.origin;
                      delete properties.options;
                    }
                    const descriptor = {
                      ...compatibleTool,
                      inputSchema,
                      title,
                      annotations: {
                        ...annotations,
                        readOnlyHint: readOnly,
                        destructiveHint:
                          typeof annotations.destructiveHint === "boolean"
                            ? annotations.destructiveHint
                            : !readOnly,
                        openWorldHint:
                          typeof annotations.openWorldHint === "boolean"
                            ? annotations.openWorldHint
                            : !readOnly,
                      },
                      // Desktop Commander's local UI metadata is meant for its
                      // own host surfaces. Do not make ChatGPT scan those
                      // resources when this connector only needs remote tools.
                      _meta: {
                        securitySchemes: [
                          { type: "oauth2", scopes: ["mcp:tools"] },
                        ],
                      },
                    };
                    return bindingToken
                      ? addChatBindingTokenToTool(descriptor, bindingToken)
                      : descriptor;
                  }),
              };
            }
            return result;
          };
          server.fallbackNotificationHandler = async (notification) => {
            await desktop.notification(notification);
          };
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (sessionId) => {
              if (!newSession) return;
              newSession.lastActivityAt = Date.now();
              sessions.set(sessionId, newSession);
              releaseSessionReservation?.();
            },
          });
          newSession = {
            transport,
            server,
            clientId: req.auth!.clientId,
            activeRequestCount: 0,
            lastActivityAt: Date.now(),
            ...(bindingToken ? { bindingToken } : {}),
            bindingScheduled: false,
          };
          await server.connect(transport as Transport);
          const onclose = transport.onclose;
          transport.onclose = () => {
            onclose?.();
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          session = newSession;
        }
        session.lastActivityAt = Date.now();
        const trackedSession = session;
        const isActiveSessionRequest = req.method === "POST";
        if (isActiveSessionRequest) trackedSession.activeRequestCount++;
        try {
          await trackedSession.transport.handleRequest(req, res, req.body);
        } finally {
          if (isActiveSessionRequest) trackedSession.activeRequestCount--;
          trackedSession.lastActivityAt = Date.now();
          releaseSessionReservation?.();
        }
      } catch {
        if (!res.headersSent)
          res.status(500).json({ error: "mcp_gateway_error" });
      } finally {
        releaseSessionReservation?.();
      }
    },
  );
  // Never allow framework error diagnostics to reflect request secrets.
  app.use(((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    res.status(400).json({ error: "invalid_request" });
  }) as express.ErrorRequestHandler);
  const http = app.listen(options.port, "127.0.0.1");
  try {
    await new Promise<void>((ok, fail) => {
      http.once("listening", ok);
      http.once("error", fail);
    });
  } catch {
    closing = true;
    await desktop.close();
    throw new Error("Loopback gateway port unavailable.");
  }
  return {
    address: http.address() as AddressInfo,
    desktopPid: desktop.snapshot().pid,
    desktopSnapshot: () => ({
      ...desktop.snapshot(),
      runtimePid: process.pid,
      publicSessionCount: sessions.size,
      activeForwardedRequestCount: forwardedRequests.size,
    }),
    setPublicUrl,
    close() {
      if (closingPromise) return closingPromise;
      closing = true;
      closingPromise = (async () => {
        for (const request of activeRequests)
          request.abort(new Error("Connector gateway is shutting down."));
        await settleWithin(Promise.allSettled([...forwardedRequests]), 1_000);
        await settleWithin(
          Promise.allSettled(
            [...sessions.values()].map((session) => session.server.close()),
          ),
          1_000,
        );
        sessions.clear();
        http.closeAllConnections();
        await settleWithin(
          new Promise<void>((resolve) => http.close(() => resolve())),
          1_000,
        );
        await desktop.close();
        await settleWithin(Promise.allSettled([...diagnosticWrites]), 1_000);
      })();
      return closingPromise;
    },
  };
}
