import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  ResultSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectorAuth } from "./connector-auth.js";
import { desktopCommand, safeEnvironment } from "./connector.js";
import {
  createConnectorWatchdog,
  type ConnectorWatchdog,
} from "./connector-watchdog.js";

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

export async function startGateway(options: {
  root: string;
  port: number;
  ownerSecret: string;
  publicUrl?: string;
  oauthClientsPath?: string | null;
  oauthStatePath?: string | null;
  onFailure?: (component: "desktop_commander") => void;
  timing?: {
    initialPingTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    heartbeatFailureThreshold?: number;
  };
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
  const command = desktopCommand(options.root);
  const stdio = new StdioClientTransport({
    command: command.file,
    args: command.args,
    env: {
      ...safeEnvironment(process.env),
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: "1",
    } as Record<string, string>,
    stderr: "ignore",
    cwd: options.root,
  });
  const local = new Client(
    { name: "devos-gateway", version: "1" },
    { capabilities: {} },
  );
  local.onerror = () => {};
  let closing = false;
  let failureReported = false;
  let watchdog: ConnectorWatchdog | undefined;
  const reportFailure = () => {
    if (closing || failureReported) return;
    failureReported = true;
    options.onFailure?.("desktop_commander");
  };
  local.onclose = () => {
    reportFailure();
  };
  try {
    await local.connect(stdio, { timeout: 15_000 });
  } catch {
    closing = true;
    await stdio.close();
    throw Object.assign(
      new Error("Local Desktop Commander initialization failed."),
      { component: "desktop_commander" },
    );
  }
  let initialSuccessAt: number;
  try {
    await local.ping({ timeout: options.timing?.initialPingTimeoutMs ?? 5_000 });
    initialSuccessAt = Date.now();
  } catch {
    closing = true;
    await stdio.close();
    throw Object.assign(
      new Error("Desktop Commander initial liveness ping failed."),
      { component: "desktop_commander" },
    );
  }
  watchdog = createConnectorWatchdog({
    ping: async (timeoutMs) => {
      await local.ping({ timeout: timeoutMs });
    },
    onFailure: reportFailure,
    initialSuccessAt,
    ...(options.timing?.heartbeatIntervalMs !== undefined
      ? { intervalMs: options.timing.heartbeatIntervalMs }
      : {}),
    ...(options.timing?.heartbeatTimeoutMs !== undefined
      ? { timeoutMs: options.timing.heartbeatTimeoutMs }
      : {}),
    ...(options.timing?.heartbeatFailureThreshold !== undefined
      ? { failureThreshold: options.timing.heartbeatFailureThreshold }
      : {}),
  });
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      server: Server;
      clientId: string;
    }
  >();
  local.fallbackNotificationHandler = async (notification) => {
    await Promise.allSettled(
      [...sessions.values()].map((s) => s.server.notification(notification)),
    );
  };
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
    const backend = watchdog?.snapshot();
    const gatewayReady = !!backend;
    const backendAlive = backend?.state === "alive";
    const oauthReady = !!provider;
    res.json({
      ready: gatewayReady && oauthReady && backendAlive,
      gatewayReady,
      oauthReady,
      backendAlive,
      backendState: backend?.state ?? "unknown",
      lastBackendOkAt: backend?.lastBackendOkAt ?? null,
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
          if (sessions.size >= 32) {
            res.status(503).json({ error: "session_capacity" });
            return;
          }
          const server = new Server(
            local.getServerVersion() ?? {
              name: "desktop-commander",
              version: "0.2.52",
            },
            {
              capabilities: local.getServerCapabilities() ?? {},
              ...(local.getInstructions()
                ? { instructions: local.getInstructions()! }
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
            const forwardedRequest = adaptChatGptToolCall(request) as typeof request;
            const result = await local.request(forwardedRequest, ResultSchema, {
              signal: extra.signal,
              ...(token !== undefined
                ? {
                    onprogress: (progress: {
                      progress: number;
                      total?: number | undefined;
                      message?: string | undefined;
                    }) => {
                      writes.push(
                        extra.sendNotification({
                          method: "notifications/progress",
                          params: { ...progress, progressToken: token },
                        }),
                      );
                    },
                  }
                : {}),
            });
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
                      // Desktop Commander's local UI metadata is meant for its
                      // own host surfaces. Do not make ChatGPT scan those
                      // resources when this connector only needs remote tools.
                      _meta: {
                        securitySchemes: [
                          { type: "oauth2", scopes: ["mcp:tools"] },
                        ],
                      },
                    };
                  }),
              };
            }
            return result;
          };
          server.fallbackNotificationHandler = async (notification) => {
            await local.notification(notification);
          };
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (sessionId) => {
              sessions.set(sessionId, {
                transport,
                server,
                clientId: req.auth!.clientId,
              });
            },
          });
          await server.connect(transport as Transport);
          const onclose = transport.onclose;
          transport.onclose = () => {
            onclose?.();
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          session = { transport, server, clientId: req.auth!.clientId };
        }
        await session.transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent)
          res.status(500).json({ error: "mcp_gateway_error" });
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
    await local.close();
    throw new Error("Loopback gateway port unavailable.");
  }
  return {
    address: http.address() as AddressInfo,
    desktopPid: stdio.pid,
    setPublicUrl,
    async close() {
      closing = true;
      await watchdog?.stop();
      await Promise.allSettled(
        [...sessions.values()].map((s) => s.server.close()),
      );
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((ok) => http.close(() => ok()));
      await local.close();
    },
  };
}
