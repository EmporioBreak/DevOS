import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CHAT_NOOP_TOOL = {
  name: "devos_noop",
  title: "DevOS no-op / chat access reference",
  description: "Read-only access check. If not approved, immediately call devos_authorize_chat with empty arguments in this same user turn to show the only password form; never ask for a second message. Never reads Mac files.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: {
    securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
  },
} as const;

type Binding = { fingerprint: string; url: string };
type BindingFile = { version: 1; entries: Binding[]; mac: string };

export function canonicalPrivateChatUrl(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new Error("Invalid ChatGPT conversation URL"); }
  const path = u.pathname.replace(/\/$/, "");
  const standalone = /^\/c\/[0-9a-f-]{16,}$/i.test(path);
  const project = /^\/g\/[a-z0-9_-]+\/c\/[0-9a-f-]{16,}$/i.test(path);
  if (u.protocol !== "https:" || u.hostname !== "chatgpt.com" ||
      u.username || u.password || u.port || u.search || u.hash ||
      !(standalone || project))
    throw new Error("Expected an exact private ChatGPT /c/<conversation_id> URL");
  return u.origin + u.pathname.replace(/\/$/, "");
}

/** Public share links label only an owner-password-approved MCP session.
 * They never prove ownership or identify a private /c conversation. */
export function canonicalChatApprovalReference(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid ChatGPT link"); }
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" ||
      url.username || url.password || url.port || url.search || url.hash)
    throw new Error("Expected a direct ChatGPT conversation/share link");
  if (/^\/share\/[0-9a-f-]{16,}\/?$/i.test(url.pathname))
    return url.origin + url.pathname.replace(/\/$/, "");
  return canonicalPrivateChatUrl(value);
}

function fingerprintFormat(value: string): boolean {
  return /^chat_[a-f0-9]{64}$/.test(value);
}

function stringSession(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 6 || value.length > 1024 ||
      value !== value.trim() || /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
  return value;
}

/** Only transport metadata from ChatGPT, never model-generated tool arguments. */
export function chatSessionSignal(request: unknown, transportHeader: unknown): string | undefined {
  if (!request || typeof request !== "object") return undefined;
  const params = (request as { params?: unknown }).params;
  const meta = params && typeof params === "object" ? (params as { _meta?: unknown })._meta : undefined;
  const hasMeta = meta && typeof meta === "object" && !Array.isArray(meta) &&
    Object.prototype.hasOwnProperty.call(meta, "openai/session");
  const fromMeta = hasMeta ? stringSession((meta as Record<string, unknown>)["openai/session"]) : undefined;
  const hasHeader = transportHeader !== undefined;
  const fromHeader = hasHeader ? stringSession(transportHeader) : undefined;
  if (hasMeta && !fromMeta) return undefined;
  if (hasHeader && !fromHeader) return undefined;
  if (fromMeta && fromHeader && fromMeta !== fromHeader) return undefined;
  return fromMeta || fromHeader;
}

export class ChatAccessRegistry {
  private readonly file: string;
  private readonly key: Buffer;
  constructor(root: string, secret: string) {
    if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 1024)
      throw new Error("Owner secret missing or too short for chat access");
    this.file = join(root, ".devos", "connector", "chat-access.json");
    this.key = createHash("sha256").update("DevOS chat access v1\0").update(secret).digest();
  }

  fingerprint(clientId: string, session: string): string {
    if (!clientId || clientId.length > 2048 || !stringSession(session))
      throw new Error("Invalid chat session identity");
    return "chat_" + createHmac("sha256", this.key)
      .update("session\0").update(clientId).update("\0").update(session).digest("hex");
  }

  private mac(entries: Binding[]): string {
    return createHmac("sha256", this.key)
      .update("allowlist\0").update(JSON.stringify({ version: 1, entries })).digest("hex");
  }

  private read(): Binding[] {
    if (!existsSync(this.file)) return [];
    const stat = lstatSync(this.file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("Chat access registry file has unsafe permissions");
    const data = JSON.parse(readFileSync(this.file, "utf8")) as BindingFile;
    if (data?.version !== 1 || !Array.isArray(data.entries) ||
        data.entries.length > 1024 || typeof data.mac !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.mac) ||
        data.entries.some(b => !b || typeof b.fingerprint !== "string" ||
          !fingerprintFormat(b.fingerprint) || typeof b.url !== "string" ||
          canonicalChatApprovalReference(b.url) !== b.url) ||
        new Set(data.entries.map(b => b.fingerprint)).size !== data.entries.length)
      throw new Error("Invalid chat access registry");
    const actual = Buffer.from(data.mac, "hex");
    const expected = Buffer.from(this.mac(data.entries), "hex");
    if (!timingSafeEqual(actual, expected))
      throw new Error("Chat access registry integrity check failed");
    return data.entries;
  }

  isApproved(fingerprint: string | undefined): boolean {
    if (!fingerprint || !fingerprintFormat(fingerprint)) return false;
    try { return this.read().some(b => b.fingerprint === fingerprint); }
    catch { return false; } // Corrupt / inaccessible registry: fail closed.
  }

  list(): Binding[] { return this.read(); }

  private save(entries: Binding[]): void {
    if (entries.length > 1024) throw new Error("Chat access registry capacity exceeded");
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = this.file + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, entries, mac: this.mac(entries) }) + "\n",
        { mode: 0o600, flag: "wx" });
      renameSync(temp, this.file);
    } finally {
      try { unlinkSync(temp); } catch {}
    }
  }

  approve(fingerprint: string, url: string): void {
    if (!fingerprintFormat(fingerprint)) throw new Error("Invalid chat reference");
    const canonical = canonicalChatApprovalReference(url);
    const entries = this.read();
    const prior = entries.find(b => b.fingerprint === fingerprint);
    if (prior && prior.url !== canonical)
      throw new Error("Conflicting chat binding: revoke before changing the URL");
    if (!prior) this.save([...entries, { fingerprint, url: canonical }]);
  }

  revoke(fingerprint: string): boolean {
    if (!fingerprintFormat(fingerprint)) throw new Error("Invalid chat reference");
    const entries = this.read();
    const next = entries.filter(b => b.fingerprint !== fingerprint);
    if (next.length === entries.length) return false;
    this.save(next);
    return true;
  }
}

export function noOpResult(reference?: string, approved = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify({
    status: "no_action",
    approved,
    ...(reference ? { chat_reference: reference } : {}),
  }) }] };
}

export function deniedChatToolResult() {
  return { isError: true, content: [{ type: "text" as const, text: "DevOS tools are not authorized for this ChatGPT conversation. Call devos_authorize_chat with empty arguments in this same user turn; only that tool can render the approval form. Never ask for a password in chat or send the user to plugin settings. No Mac operation was performed." }] };
}
