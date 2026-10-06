import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

const opaque = () => randomBytes(32).toString("base64url");
const digest = (s: string) => createHash("sha256").update(s).digest();
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Grant = { clientId: string; params: AuthorizationParams; expires: number };
type Token = {
  clientId: string;
  scopes: string[];
  expires: number;
  resource: URL;
  family: string;
};

// Public dynamic-client registrations and active bearer state persist locally
// so trusted clients can survive an ordinary DevOS restart. Bearer state is
// encrypted at rest with a key derived from the owner secret, bound to the
// exact public MCP resource, and protected by 0600 file permissions.
// Every map is bounded, expired entries are pruned before admitting new entries.
export interface ConnectorAuthPersistenceHooks {
  beforeAuthStateCommit?: () => void;
  afterAuthStateCommit?: () => void;
}

export class ConnectorAuth implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private approvedClients = new Set<string>();
  private pending = new Map<string, Grant>();
  private codes = new Map<string, Grant>();
  private access = new Map<string, Token>();
  private refresh = new Map<string, Token>();
  private usedRefresh = new Map<string, Token>();
  private ownerDigest: Buffer;
  constructor(
    private resource: URL,
    ownerSecret: string,
    private clientsPath?: string,
    private statePath?: string,
    private persistenceHooks: ConnectorAuthPersistenceHooks = {},
  ) {
    this.ownerDigest = digest(ownerSecret);
    this.loadPublicClients();
    this.loadAuthState();
  }

  private tokenFromDisk(value: unknown): Token | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as {
      clientId?: unknown;
      scopes?: unknown;
      expires?: unknown;
      resource?: unknown;
      family?: unknown;
    };
    if (
      typeof candidate.clientId !== "string" ||
      !this.clients.has(candidate.clientId) ||
      !Array.isArray(candidate.scopes) ||
      candidate.scopes.some((scope) => typeof scope !== "string") ||
      typeof candidate.expires !== "number" ||
      !Number.isFinite(candidate.expires) ||
      candidate.expires <= Date.now() ||
      candidate.resource !== this.resource.href ||
      typeof candidate.family !== "string"
    )
      return undefined;
    return {
      clientId: candidate.clientId,
      scopes: candidate.scopes as string[],
      expires: candidate.expires,
      resource: this.resource,
      family: candidate.family,
    };
  }

  private loadAuthState() {
    if (!this.statePath) return;
    try {
      const envelope = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        version?: unknown;
        iv?: unknown;
        tag?: unknown;
        data?: unknown;
      };
      if (
        envelope.version !== 1 ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.data !== "string"
      )
        throw new Error("invalid envelope");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.ownerDigest,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(this.resource.href));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64url")),
        decipher.final(),
      ]);
      const parsed = JSON.parse(clear.toString("utf8")) as {
        version?: unknown;
        resource?: unknown;
        access?: unknown;
        refresh?: unknown;
        usedRefresh?: unknown;
      };
      if (
        parsed.version !== 1 ||
        parsed.resource !== this.resource.href ||
        !Array.isArray(parsed.access) ||
        !Array.isArray(parsed.refresh) ||
        !Array.isArray(parsed.usedRefresh)
      )
        throw new Error("invalid state");
      for (const [target, entries] of [
        [this.access, parsed.access],
        [this.refresh, parsed.refresh],
        [this.usedRefresh, parsed.usedRefresh],
      ] as const)
        for (const entry of entries.slice(0, 256)) {
          if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
          const token = this.tokenFromDisk(entry[1]);
          if (token) target.set(entry[0], token);
        }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      try {
        unlinkSync(this.statePath);
      } catch {}
    }
  }

  private persistAuthState() {
    if (!this.statePath) return;
    const serialize = (map: Map<string, Token>) =>
      [...map]
        .filter(([, token]) => token.expires > Date.now())
        .map(([key, token]) => [
          key,
          {
            ...token,
            resource: token.resource.href,
          },
        ]);
    const clear = Buffer.from(
      JSON.stringify({
        version: 1,
        resource: this.resource.href,
        access: serialize(this.access),
        refresh: serialize(this.refresh),
        usedRefresh: serialize(this.usedRefresh),
      }),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.ownerDigest, iv);
    cipher.setAAD(Buffer.from(this.resource.href));
    const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      data: encrypted.toString("base64url"),
    });
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp =
      this.statePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, envelope, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      this.persistenceHooks.beforeAuthStateCommit?.();
      renameSync(tmp, this.statePath);
      this.persistenceHooks.afterAuthStateCommit?.();
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }

  private validateClientMetadata(
    metadata: Pick<
      OAuthClientInformationFull,
      "redirect_uris" | "token_endpoint_auth_method"
    >,
  ) {
    if (
      !metadata.redirect_uris.length ||
      metadata.redirect_uris.length > 8 ||
      metadata.redirect_uris.some((value) => {
        try {
          const u = new URL(value);
          return (
            !!u.username ||
            !!u.password ||
            !!u.hash ||
            /[;\s]/.test(u.origin) ||
            !(
              u.protocol === "https:" ||
              (u.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
            )
          );
        } catch {
          return true;
        }
      })
    )
      throw new InvalidClientMetadataError(
        "Only HTTPS or loopback callback URLs are allowed.",
      );
    if (
      !["none", "client_secret_post"].includes(
        metadata.token_endpoint_auth_method ?? "client_secret_post",
      )
    )
      throw new InvalidClientMetadataError(
        "Unsupported client authentication method.",
      );
  }

  private loadPublicClients() {
    if (!this.clientsPath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.clientsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Invalid durable OAuth client registry.");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      !Array.isArray((parsed as { clients?: unknown }).clients)
    )
      throw new Error("Invalid durable OAuth client registry.");
    const registry = parsed as {
      clients: OAuthClientInformationFull[];
      approvedClientIds?: unknown;
    };
    for (const candidate of registry.clients.slice(0, 256)) {
      if (
        !candidate ||
        typeof candidate.client_id !== "string" ||
        candidate.client_secret ||
        (candidate.token_endpoint_auth_method ?? "client_secret_post") !== "none"
      )
        continue;
      try {
        this.validateClientMetadata(candidate);
      } catch {
        continue;
      }
      this.clients.set(candidate.client_id, candidate);
    }
    if (Array.isArray(registry.approvedClientIds))
      for (const id of registry.approvedClientIds.slice(0, 256))
        if (typeof id === "string" && this.clients.has(id))
          this.approvedClients.add(id);
  }

  private persistPublicClients() {
    if (!this.clientsPath) return;
    mkdirSync(dirname(this.clientsPath), { recursive: true, mode: 0o700 });
    const clients = [...this.clients.values()].filter(
      (client) =>
        !client.client_secret &&
        (client.token_endpoint_auth_method ?? "client_secret_post") === "none",
    );
    const tmp =
      this.clientsPath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          clients,
          approvedClientIds: [...this.approvedClients].filter((id) =>
            clients.some((client) => client.client_id === id),
          ),
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      renameSync(tmp, this.clientsPath);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  }
  private prune() {
    for (const map of [
      this.pending,
      this.codes,
      this.access,
      this.refresh,
      this.usedRefresh,
    ])
      for (const [key, value] of map)
        if (value.expires <= Date.now()) map.delete(key);
  }
  private capacity(map: Map<string, unknown>) {
    this.prune();
    if (map.size >= 256)
      throw new InvalidRequestError(
        "Connector authorization capacity reached; restart or retry later.",
      );
  }
  clientsStore = {
    getClient: async (id: string) => this.clients.get(id),
    registerClient: async (
      metadata: Omit<
        OAuthClientInformationFull,
        "client_id" | "client_id_issued_at"
      >,
    ): Promise<OAuthClientInformationFull> => {
      this.capacity(this.clients);
      this.validateClientMetadata(metadata);
      const client = {
        ...metadata,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      this.clients.set(client.client_id, client);
      if (
        !client.client_secret &&
        (client.token_endpoint_auth_method ?? "client_secret_post") === "none"
      )
        this.persistPublicClients();
      return client;
    },
  };

  private redirectGrant(grant: Grant, res: Response) {
    this.capacity(this.codes);
    const code = opaque();
    this.codes.set(code, { ...grant, expires: Date.now() + 60_000 });
    const callback = new URL(grant.params.redirectUri);
    callback.searchParams.set("code", code);
    if (grant.params.state !== undefined)
      callback.searchParams.set("state", grant.params.state);
    res.set("Cache-Control", "no-store").redirect(302, callback.href);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    if (params.resource && params.resource.href !== this.resource.href)
      throw new InvalidRequestError("Invalid MCP resource.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("Invalid S256 challenge.");
    if (
      params.scopes?.some(
        (scope) => scope !== "mcp:tools" && scope !== "offline_access",
      )
    )
      throw new InvalidScopeError(
        "Only mcp:tools and offline_access scopes are supported.",
      );
    const grant = {
      clientId: client.client_id,
      params,
      expires: Date.now() + 300_000,
    };
    if (this.approvedClients.has(client.client_id)) {
      this.redirectGrant(grant, res);
      return;
    }
    this.capacity(this.pending);
    const ticket = opaque();
    this.pending.set(ticket, grant);
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; form-action 'self' ${new URL(params.redirectUri).origin}; frame-ancestors 'none'`,
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    res
      .type("html")
      .send(
        `<!doctype html><html lang="ru"><meta charset="utf-8"><title>DevOS — доступ к Mac</title><h1>Разрешить доступ к локальному Mac?</h1><p>Клиент: ${escape(client.client_name ?? client.client_id)}</p><p>Callback: ${escape(params.redirectUri)}</p><p>Клиент получит все инструменты Desktop Commander, включая чтение/запись файлов и запуск команд. Продолжайте только для своего доверенного клиента.</p><form method="post" action="/consent"><input type="hidden" name="ticket" value="${ticket}"><label>Локальный секрет владельца <input type="password" name="secret" autocomplete="off" required></label><button type="submit">Разрешить</button></form></html>`,
      );
  }
  consent(ticket: unknown, secret: unknown, res: Response) {
    this.prune();
    const grant =
      typeof ticket === "string" ? this.pending.get(ticket) : undefined;
    if (
      !grant ||
      typeof secret !== "string" ||
      !timingSafeEqual(digest(secret), this.ownerDigest)
    ) {
      res.status(403).json({ error: "access_denied" });
      return;
    }
    this.pending.delete(ticket as string);
    this.approvedClients.add(grant.clientId);
    this.persistPublicClients();
    this.redirectGrant(grant, res);
  }
  private grant(client: OAuthClientInformationFull, code: string) {
    this.prune();
    const grant = this.codes.get(code);
    if (!grant || grant.clientId !== client.client_id)
      throw new InvalidGrantError("Invalid or expired authorization code.");
    return grant;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    return this.grant(client, code).params.codeChallenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = this.grant(client, code);
    if (
      redirectUri !== grant.params.redirectUri ||
      (resource && resource.href !== this.resource.href)
    )
      throw new InvalidGrantError("Invalid redirect or resource.");
    const tokens = this.issue(
      client.client_id,
      opaque(),
      grant.params.scopes?.length ? grant.params.scopes : ["mcp:tools"],
    );
    this.codes.delete(code);
    return tokens;
  }
  private issue(
    clientId: string,
    family: string,
    scopes: string[] = ["mcp:tools"],
    persist = true,
  ): OAuthTokens {
    this.capacity(this.access);
    this.capacity(this.refresh);
    const access = opaque(),
      refresh = opaque();
    const normalizedScopes = [...new Set(scopes)];
    const data = {
      clientId,
      scopes: normalizedScopes,
      resource: this.resource,
      family,
    };
    this.access.set(access, { ...data, expires: Date.now() + 3600_000 });
    this.refresh.set(refresh, { ...data, expires: Date.now() + 24 * 3600_000 });
    if (persist) this.persistAuthState();
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
      scope: normalizedScopes.join(" "),
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.prune();
    const data = this.refresh.get(token);
    const replay = this.usedRefresh.get(token);
    if (replay?.clientId === client.client_id) this.revokeFamily(replay.family);
    if (
      !data ||
      data.clientId !== client.client_id ||
      (resource && resource.href !== this.resource.href)
    )
      throw new InvalidGrantError("Invalid refresh token or resource.");
    if (scopes?.some((scope) => !data.scopes.includes(scope)))
      throw new InvalidScopeError("Invalid scope.");
    this.capacity(this.usedRefresh);
    const tokens = this.issue(
      data.clientId,
      data.family,
      scopes?.length ? scopes : data.scopes,
      false,
    );
    this.usedRefresh.set(token, data);
    this.refresh.delete(token);
    this.persistAuthState();
    return tokens;
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.prune();
    const data = this.access.get(token);
    if (!data) throw new InvalidTokenError("Invalid or expired token.");
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expires / 1000),
      resource: data.resource,
    };
  }
  private revokeFamily(family: string) {
    for (const map of [this.access, this.refresh, this.usedRefresh])
      for (const [key, value] of map)
        if (value.family === family) map.delete(key);
    this.persistAuthState();
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    const data =
      this.access.get(request.token) ??
      this.refresh.get(request.token) ??
      this.usedRefresh.get(request.token);
    if (data?.clientId !== client.client_id) return;
    this.revokeFamily(data.family);
  }
}
