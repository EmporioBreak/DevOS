import express from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
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
export async function startGateway(options: {
  root: string;
  port: number;
  ownerSecret: string;
  publicUrl?: string;
  onFailure?: () => void;
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
  local.onclose = () => {
    if (!closing) options.onFailure?.();
  };
  try {
    await local.connect(stdio, { timeout: 15_000 });
  } catch {
    await stdio.close();
    throw new Error("Local Desktop Commander initialization failed.");
  }
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
    provider = new ConnectorAuth(resource, options.ownerSecret);
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
  app.get("/health", (_req, res) => res.json({ ready: !!provider }));
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
    "/mcp",
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
            const result = await local.request(request, ResultSchema, {
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
              return {
                ...listed,
                tools: listed.tools.map((tool) => {
                  const annotations =
                    tool.annotations && typeof tool.annotations === "object"
                      ? (tool.annotations as Record<string, unknown>)
                      : {};
                  const readOnly = annotations.readOnlyHint === true;
                  const title =
                    typeof tool.title === "string"
                      ? tool.title
                      : typeof annotations.title === "string"
                        ? annotations.title
                        : String(tool.name ?? "Desktop Commander tool");
                  const meta =
                    tool._meta && typeof tool._meta === "object"
                      ? (tool._meta as Record<string, unknown>)
                      : {};
                  return {
                    ...tool,
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
                    _meta: {
                      ...meta,
                      // OpenAI compatibility mirror. SDK 1.32.1 preserves
                      // arbitrary _meta while its ToolSchema predates the
                      // top-level securitySchemes field.
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
