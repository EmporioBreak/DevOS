import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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

// Ephemeral credentials belong to this foreground run. Restart revokes all grants.
// Every map is bounded, expired entries are pruned before admitting new entries.
export class ConnectorAuth implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, Grant>();
  private codes = new Map<string, Grant>();
  private access = new Map<string, Token>();
  private refresh = new Map<string, Token>();
  private usedRefresh = new Map<string, Token>();
  private ownerDigest: Buffer;
  constructor(
    private resource: URL,
    ownerSecret: string,
  ) {
    this.ownerDigest = digest(ownerSecret);
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
      const client = {
        ...metadata,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      };
      this.clients.set(client.client_id, client);
      return client;
    },
  };
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
    this.capacity(this.pending);
    const ticket = opaque();
    this.pending.set(ticket, {
      clientId: client.client_id,
      params,
      expires: Date.now() + 300_000,
    });
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
    this.capacity(this.codes);
    this.pending.delete(ticket as string);
    const code = opaque();
    this.codes.set(code, { ...grant, expires: Date.now() + 60_000 });
    const callback = new URL(grant.params.redirectUri);
    callback.searchParams.set("code", code);
    if (grant.params.state !== undefined)
      callback.searchParams.set("state", grant.params.state);
    res.set("Cache-Control", "no-store").redirect(302, callback.href);
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
    );
    this.usedRefresh.set(token, data);
    this.refresh.delete(token);
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
