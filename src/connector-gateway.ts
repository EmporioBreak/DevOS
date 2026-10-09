import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { DevosToolRegistry } from "./mcp-tools/registry.js";
import { ChatAccessRegistry, CHAT_NOOP_TOOL, chatSessionSignal, noOpResult, deniedChatToolResult } from "./chat-access.js";
import { ChatApprovalTickets, CHAT_APPROVAL_WIDGET_TOOL, CHAT_APPROVAL_WIDGET_URI, chatApprovalWidget, externalChatApprovalForm, CHAT_PREVIOUS_APPROVAL_WIDGET_URI } from "./chat-access-widget.js";
import { ChatWorkerProbeRegistry, CHAT_WORKER_PROBE_TOOL } from "./chat-worker-probe.js";
import { ChatWorkerGrantRegistry } from "./chat-worker-grants.js";
import { appendDesktopCommanderDiagnostic } from "./connector-diagnostics.js";

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
  fingerprints: Set<string>;
  activeRequestCount: number;
  lastActivityAt: number;
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
  /** Project owning the chat allowlist; may differ from the software checkout. */
  chatAccessRoot?: string;
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
      req.headers.origin !== identity.origin &&
      req.path !== "/chat-access/approve" && req.path !== "/chat-access/check" && req.path !== "/chat-access/form"
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
  const localTools = new DevosToolRegistry(options.root);
  const chatAccess = new ChatAccessRegistry(options.chatAccessRoot ?? options.root, options.ownerSecret);
  const chatApproval = new ChatApprovalTickets(
    options.chatAccessRoot ?? options.root, chatAccess, undefined,
    (fingerprint) => {
      // Tell surviving MCP clients to refresh their tool metadata so the
      // approval template is removed from subsequently approved operations.
      // Some iOS clients ignore list_changed: the widget still hides itself.
      for (const session of sessions.values())
        if (session.fingerprints.has(fingerprint))
          void session.server.sendToolListChanged().catch(() => {});
    },
  );
  const workerProbe = new ChatWorkerProbeRegistry(options.chatAccessRoot ?? options.root, options.ownerSecret);
  const workerGrants = new ChatWorkerGrantRegistry(options.chatAccessRoot ?? options.root, options.ownerSecret);
  const callOrigin = new AsyncLocalStorage<{ clientId: string; sessionHeader: unknown }>();
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

  // Browser fallback for native clients that cannot render MCP Apps.
  // The fragment-only ticket never reaches this GET request.
  app.get("/chat-access/form", (_req, res) => {
    res.set({ "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
    res.type("html").send(externalChatApprovalForm());
  });

  // Read-only active-challenge check. Prevent old or duplicate inline cards
  // from reappearing after another card already authorized the same chat.
  app.post("/chat-access/check",
    (_req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); },
    rateLimit({ windowMs: 15 * 60_000, limit: 1200, standardHeaders: false, legacyHeaders: false }),
    express.json({ limit: "1kb", type: "application/json" }),
    (req, res) => {
      const body = req.body;
      const ticket = body && typeof body === "object" && !Array.isArray(body) &&
        Object.keys(body).length === 1 ? body.ticket : undefined;
      res.status(200).json({ pending: chatApproval.isPending(ticket) });
    },
  );
  app.options("/chat-access/check", (_req, res) => {
    res.set({ "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type" }).sendStatus(204);
  });

  // Public only for widget-to-gateway HTTPS fetch: a one-time ticket issued
  // through authenticated MCP AND an independent high-entropy password are required.
  // No cookies or ambient bearer credentials. Never log request body or password.
  app.options("/chat-access/approve", (_req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    }).sendStatus(204);
  });
  app.post("/chat-access/approve",
    (_req, res, next) => { res.set("Access-Control-Allow-Origin", "*"); next(); },
    rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: false, legacyHeaders: false }),
    express.json({ limit: "4kb", type: "application/json" }),
    (req, res) => {
      res.set("Access-Control-Allow-Origin", "*");
      const approved = chatApproval.approve(req.body);
      res.status(approved ? 200 : 403).json(approved
        ? { approved: true }
        : { approved: false, error: "authorization_failed" });
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
          const server = new Server(
            localInfo.version ?? {
              name: "desktop-commander",
              version: "0.2.52",
            },
            {
              capabilities: { ...(localInfo.capabilities ?? {}), resources: {} },
              ...(localInfo.instructions
                ? { instructions: localInfo.instructions }
                : {}),
            },
          );
          server.onerror = () => {};
          const sessionFingerprints = new Set<string>();
          server.fallbackRequestHandler = async (request, extra) => {
            const token = (
              request.params?._meta as
                | { progressToken?: string | number }
                | undefined
            )?.progressToken;
            const writes: Promise<void>[] = [];
            // Authorize before parsing tool arguments or accessing Desktop Commander.
            // The HTTP context is bound to EACH request, not to the MCP session's
            // initialization request; concurrent requests never borrow identities.
            const origin = callOrigin.getStore();
            const signal = chatSessionSignal(request, origin?.sessionHeader);
            const fingerprint = signal && origin
              ? chatAccess.fingerprint(origin.clientId, signal)
              : undefined;
            if (fingerprint) sessionFingerprints.add(fingerprint);
            const authorized = chatAccess.isApproved(fingerprint) || workerGrants.isGranted(fingerprint);
            if (request.method === "tools/call") {
              if (request.params?.name === CHAT_NOOP_TOOL.name) {
                if (authorized) return {
                  ...noOpResult(fingerprint, true),
                  structuredContent: { status: "no_action", approved: true,
                    ready: false, reason: "already_authorized",
                    ...(fingerprint ? { chat_reference: fingerprint } : {}) },
                };
                const issued = chatApproval.issue(fingerprint);
                return {
                  ...noOpResult(fingerprint, false),
                  ...((issued.ready || issued.reason === "approval_pending") && identity ? { content: [{
                    type: "text", text: JSON.stringify({
                      status: "no_action", approved: false, chat_reference: fingerprint,
                      authorization_required: true,
                      approval_url: new URL("/chat-access/form", identity).href + "#" + issued.ticket,
                    }),
                  }] } : {}),
                  structuredContent: { status: "no_action", approved: false,
                    ...(fingerprint ? { chat_reference: fingerprint } : {}), ...issued,
                    ...((issued.ready || issued.reason === "approval_pending") && identity ? {
                      approval_url: new URL("/chat-access/form", identity).href + "#" + issued.ticket,
                    } : {}) },
                };
              }
              if (request.params?.name === CHAT_WORKER_PROBE_TOOL.name) {
                const issued = workerProbe.issue(fingerprint);
                return { content: [{ type: "text", text: JSON.stringify(issued) }], structuredContent: issued };
              }
              if (request.params?.name === CHAT_APPROVAL_WIDGET_TOOL.name) {
                if (authorized) return noOpResult(fingerprint, true);
                const issued = chatApproval.issue(fingerprint);
                const link = (issued.ready || issued.reason === "approval_pending") && identity
                  ? new URL("/chat-access/form", identity).href + "#" + issued.ticket
                  : undefined;
                return { content: [{ type: "text", text: JSON.stringify(issued) +
                  (link ? "\\nЕсли форма не отображается в ChatGPT для iOS, открой через Safari: " + link : "") }],
                  structuredContent: { ...issued, ...(link ? { approval_url: link } : {}) } };
              }
              if (!authorized) {
                const issued = chatApproval.issue(fingerprint);
                // On iOS a tool result marked isError is not rendered as an
                // MCP App, even with a UI template. Report a *successful*
                // protocol response describing a denied operation instead.
                // The requested command is NEVER forwarded on this path.
                if (issued.ready) {
                  const result = {
                    status: "authorization_required",
                    operation_executed: false,
                    ...issued,
                    ...(identity ? {
                      approval_url: new URL("/chat-access/form", identity).href + "#" + issued.ticket,
                    } : {}),
                  };
                  return {
                    content: [{ type: "text", text:
                      "Authorization required; the requested DevOS operation was NOT executed. " +
                      "Open the attached inline approval form. On successful approval it asks ChatGPT to continue the original task automatically; do not tell the user to write 'Готово'. If the mobile app does not show the form, use this DevOS Safari link: " +
                      (identity ? new URL("/chat-access/form", identity).href + "#" + issued.ticket : "") +
                      " . The operation was NOT executed; never put a password into chat or plugin settings." }],
                    structuredContent: result,
                    _meta: { ui: { resourceUri: CHAT_APPROVAL_WIDGET_URI },
                      "openai/outputTemplate": CHAT_APPROVAL_WIDGET_URI },
                  };
                }
                if (issued.reason === "approval_pending") {
                  // Another tool already displayed this chat's only form.
                  // Do not mark as an error or attach another MCP App widget.
                  const link = identity
                    ? new URL("/chat-access/form", identity).href + "#" + issued.ticket
                    : undefined;
                  const result = {
                    status: "authorization_pending", operation_executed: false,
                    ...issued, ...(link ? { approval_url: link } : {}),
                  };
                  return {
                    content: [{ type: "text", text:
                      "DevOS authorization is already awaiting confirmation in the first form. " +
                      "This Mac operation was not executed. Do not open another form or request another password." +
                      (link ? " Safari fallback: " + link : "") }],
                    structuredContent: result,
                  };
                }
                return deniedChatToolResult();
              }
            } else if (request.method === "resources/list") {
              return { resources: [{
                name: "DevOS chat access approval form",
                uri: CHAT_APPROVAL_WIDGET_URI,
                mimeType: "text/html;profile=mcp-app",
              }] };
            } else if (request.method === "resources/read" &&
                       (request.params?.uri === CHAT_APPROVAL_WIDGET_URI ||
                        request.params?.uri === CHAT_PREVIOUS_APPROVAL_WIDGET_URI)) {
              if (!identity) throw new Error("Connector public origin unavailable");
              const html = chatApprovalWidget(identity.origin);
              return { contents: [{
                uri: request.params?.uri ?? CHAT_APPROVAL_WIDGET_URI,
                mimeType: "text/html;profile=mcp-app",
                text: html,
                _meta: {
                  ui: {
                    csp: { connectDomains: [identity.origin], resourceDomains: [] },
                    prefersBorder: true,
                  },
                  "openai/ui": { availableDisplayModes: ["inline"] },
                  "openai/widgetCSP": { connect_domains: [identity.origin], resource_domains: [] },
                  "openai/widgetPrefersBorder": true,
                },
              }] };
            } else if (request.method !== "tools/list" && request.method !== "ping" &&
                       !authorized) {
              throw new Error("MCP request not authorized for this conversation");
            }
            const forwardedRequest = adaptChatGptToolCall(request) as typeof request;
            const toolCall = request.method === "tools/call";
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
              if (forwardedRequest.method === "tools/call" &&
                  typeof forwardedRequest.params?.name === "string" &&
                  localTools.has(forwardedRequest.params.name)) {
                forwardedRequestPromise = localTools.call(
                  forwardedRequest.params.name, forwardedRequest.params.arguments,
                );
              } else if (forwardedRequest.method === "tools/call" &&
                         typeof forwardedRequest.params?.name === "string" &&
                         forwardedRequest.params.name.startsWith("devos_")) {
                throw new Error("Unknown DevOS tool");
              } else if (forwardedRequest.method === "tools/list") {
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
              const conflicting = listed.tools.find(tool =>
                String(tool.name ?? "") === CHAT_NOOP_TOOL.name ||
                String(tool.name ?? "") === CHAT_WORKER_PROBE_TOOL.name ||
                String(tool.name ?? "") === CHAT_APPROVAL_WIDGET_TOOL.name ||
                localTools.has(String(tool.name ?? "")) ||
                String(tool.name ?? "").startsWith("devos_"));
              if (conflicting) throw new Error("Desktop Commander tool conflicts with reserved DevOS namespace");
              const excludedForChatGpt = new Set(["track_ui_event"]);
              return {
                ...listed,
                tools: [...listed.tools
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
                    return {
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
                      // For an unapproved ChatGPT conversation, the first
                      // requested operation itself has an approval UI. Host
                      // clients choose widgets from tools/list metadata, not
                      // from an error response's metadata alone.
                      _meta: {
                        ...(!authorized ? {
                          ui: { resourceUri: CHAT_APPROVAL_WIDGET_URI },
                          "openai/outputTemplate": CHAT_APPROVAL_WIDGET_URI,
                        } : {}),
                        securitySchemes: [
                          { type: "oauth2", scopes: ["mcp:tools"] },
                        ],
                      },
                    };
                  }), ...localTools.list().map(tool => ({
                    ...tool,
                    ...(!authorized ? {
                      _meta: {
                        ...(tool._meta ?? {}),
                        ui: { resourceUri: CHAT_APPROVAL_WIDGET_URI },
                        "openai/outputTemplate": CHAT_APPROVAL_WIDGET_URI,
                      },
                    } : {}),
                  })),
                  ...(authorized
                    ? [CHAT_NOOP_TOOL, CHAT_APPROVAL_WIDGET_TOOL].map(tool => ({
                        ...tool,
                        // Once approved, even safe helper tools must not
                        // advertise another password card.
                        _meta: { securitySchemes: [
                          { type: "oauth2", scopes: ["mcp:tools"] },
                        ] },
                      }))
                    : [CHAT_NOOP_TOOL, CHAT_APPROVAL_WIDGET_TOOL]),
                  CHAT_WORKER_PROBE_TOOL],
              };
            }
            return result;
          };
          server.fallbackNotificationHandler = async (notification) => {
            const origin = callOrigin.getStore();
            const signal = chatSessionSignal(notification, origin?.sessionHeader);
            const fingerprint = signal && origin
              ? chatAccess.fingerprint(origin.clientId, signal)
              : undefined;
            if (!chatAccess.isApproved(fingerprint) && !workerGrants.isGranted(fingerprint)) return;
            await desktop.notification(notification);
          };
          let newSession: PublicMcpSession | undefined;
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
            fingerprints: sessionFingerprints,
            activeRequestCount: 0,
            lastActivityAt: Date.now(),
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
          await callOrigin.run({
            clientId: req.auth!.clientId,
            sessionHeader: req.headers["x-openai-session"],
          }, () => trackedSession.transport.handleRequest(req, res, req.body));
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
