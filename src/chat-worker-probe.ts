import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, renameSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";

/** A probe is never an authorization grant. It supplies a server-origin
 * nonce that the trusted browser must observe in a provider-authored tool
 * result from the exact worker conversation before local redemption. */
export const CHAT_WORKER_PROBE_TOOL = {
  name: "devos_worker_probe",
  title: "DevOS worker identity probe (no access grant)",
  description: "Only for browser workers launched by the local DevOS orchestrator. A one-time read-only identity challenge; NEVER grants Mac access itself. Do not call from user-created or ordinary ChatGPT chats; those use the separate owner approval form.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] },
} as const;

type Pending = { version: 1; fingerprint: string; issuedAt: number; expiresAt: number; mac: string };
const NONCE = /^[a-f0-9]{64}$/;
const FINGERPRINT = /^chat_[a-f0-9]{64}$/;
const TTL_MS = 2 * 60_000;
const MAX_PENDING = 128;
const MAX_DIRECTORY_ENTRIES = MAX_PENDING * 2;
const MAX_PENDING_FILE_BYTES = 4096;

export class ChatWorkerProbeRegistry {
  private readonly dir: string;
  private readonly key: Buffer;
  constructor(root: string, secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error("Worker probe requires owner secret");
    this.dir = join(root, ".devos", "connector", "worker-probes");
    this.key = createHash("sha256").update("DevOS worker probe v1\0").update(secret).digest();
  }
  private hmac(value: string): string {
    return createHmac("sha256", this.key).update(value).digest("hex");
  }
  private path(nonce: string): string {
    if (!NONCE.test(nonce)) throw new Error("Invalid worker probe challenge");
    return join(this.dir, this.hmac("path\0" + nonce) + ".json");
  }
  private signed(row: Omit<Pending, "mac">): string {
    return this.hmac("record\0" + JSON.stringify(row));
  }
  /** Enumerate a bounded catalog. Overflow is ambiguous evidence and fails closed. */
  private candidateFiles(): string[] | null {
    let dir;
    try { dir = opendirSync(this.dir); } catch { return null; }
    const candidates: string[] = [];
    let entries = 0;
    try {
      while (true) {
        const entry = dir.readSync();
        if (!entry) return candidates;
        if (++entries > MAX_DIRECTORY_ENTRIES) return null;
        if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          candidates.push(entry.name);
          if (candidates.length > MAX_PENDING) return null;
        }
      }
    } finally { dir.closeSync(); }
  }
  /** Read bounded bytes from an already-open private regular file. Candidate
   * paths are constructed only from registry-owned names. */
  private readPendingRecord(path: string): Pending | null {
    let fd: number | undefined;
    try {
      const before = lstatSync(path);
      if (!before.isFile() || (before.mode & 0o777) !== 0o600 || before.size > MAX_PENDING_FILE_BYTES) return null;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o777) !== 0o600 || st.size > MAX_PENDING_FILE_BYTES ||
          st.dev !== before.dev || st.ino !== before.ino) return null;
      const bytes = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (read === 0) return null;
        offset += read;
      }
      const after = fstatSync(fd);
      if (after.dev !== st.dev || after.ino !== st.ino || after.size !== st.size ||
          (after.mode & 0o777) !== 0o600) return null;
      return JSON.parse(bytes.toString("utf8")) as Pending;
    } catch { return null; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  }
  private authentic(row: Pending): boolean {
    try {
      const plain = { version: 1 as const, fingerprint: row.fingerprint, issuedAt: row.issuedAt, expiresAt: row.expiresAt };
      const mac = typeof row.mac === "string" && /^[a-f0-9]{64}$/.test(row.mac) ? Buffer.from(row.mac, "hex") : null;
      return row.version === 1 && FINGERPRINT.test(row.fingerprint) && Number.isSafeInteger(row.issuedAt) &&
        Number.isSafeInteger(row.expiresAt) && row.expiresAt - row.issuedAt === TTL_MS && mac !== null &&
        timingSafeEqual(mac, Buffer.from(this.signed(plain), "hex"));
    } catch { return false; }
  }
  /** True only while a private, fresh, HMAC-verified challenge for this exact
   * fingerprint remains on disk. This is a wait hint, never an authorization. */
  hasFreshPending(fingerprint: string | undefined, now = Date.now()): boolean {
    if (!fingerprint || !FINGERPRINT.test(fingerprint)) return false;
    try {
      const files = this.candidateFiles();
      if (!files) return false;
      for (const file of files) {
        try {
          const path = join(this.dir, file);
          const row = this.readPendingRecord(path);
          if (row && row.fingerprint === fingerprint && now >= row.issuedAt && now < row.expiresAt &&
              this.authentic(row)) return true;
        } catch { /* malformed or concurrently claimed evidence is ignored */ }
      }
    } catch { /* missing/inaccessible probe directory means no wait */ }
    return false;
  }
  /** Safe for any OAuth caller; never reveals session fingerprint or raw session id. */
  issue(fingerprint: string | undefined, now = Date.now()) {
    if (!fingerprint || !FINGERPRINT.test(fingerprint))
      return { status: "unavailable" as const };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let files = this.candidateFiles();
    if (!files) return { status: "capacity" as const };
    if (files.length >= MAX_PENDING) {
      for (const file of files) {
        try {
          const path = join(this.dir, file);
          const row = this.readPendingRecord(path);
          if (row && this.authentic(row) && row.expiresAt < now)
            unlinkSync(path);
        } catch { /* uncertain evidence is not trusted or reused */ }
      }
      files = this.candidateFiles();
      if (!files || files.length >= MAX_PENDING)
        return { status: "capacity" as const };
    }
    const nonce = randomBytes(32).toString("hex");
    const row = { version: 1 as const, fingerprint, issuedAt: now, expiresAt: now + TTL_MS };
    writeFileSync(this.path(nonce), JSON.stringify({ ...row, mac: this.signed(row) }), { flag: "wx", mode: 0o600 });
    return { status: "issued" as const, nonce, expires_in_seconds: TTL_MS / 1000 };
  }
  /** Local trusted executor only; NEVER expose through MCP or an HTTP route.
   * An untrusted model cannot reach this API; the caller must first prove a
   * provider-authored exact-chat tool result, not text or arguments. */
  claim(nonce: string, now = Date.now()): string | null {
    if (!NONCE.test(nonce)) return null;
    const source = this.path(nonce);
    if (!existsSync(source)) return null;
    const claimed = source + "." + randomUUID() + ".claimed";
    try { renameSync(source, claimed); } catch { return null; }
    try {
      const row = this.readPendingRecord(claimed);
      if (!row || now < row.issuedAt || now >= row.expiresAt || !this.authentic(row)) return null;
      return row.fingerprint;
    } catch { return null; }
    finally { try { unlinkSync(claimed); } catch {} }
  }
}

/** Parse ONLY a server-origin tool result in the exact saved conversation.
 * Provider's resource_uri must be pinned to this installed DevOS connector.
 * Never inspect assistant text, arbitrary function output, or tool arguments. */
export function exactWorkerProbeResult(message: unknown, allowedResourceUri: string): string | null {
  if (!allowedResourceUri || !/^\/[^/?]+\/[^/?]+\/devos_worker_probe$/.test(allowedResourceUri)) return null;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const m = message as any;
  if (m.author?.role !== "tool" || m.author?.name !== "api_tool.call_tool" ||
      m.status !== "finished_successfully" ||
      m.metadata?.invoked_resource?.resource_uri !== allowedResourceUri ||
      m.content?.content_type !== "code" || typeof m.content?.text !== "string") return null;
  let result: any;
  try { result = JSON.parse(m.content.text); } catch { return null; }
  // ChatGPT's API tool carrier may wrap the app result under a result property.
  const candidates = [result?.structuredContent, result?.result?.structuredContent, result?.result, result];
  for (const item of candidates) {
    if (item && item.status === "issued" && typeof item.nonce === "string" &&
        NONCE.test(item.nonce)) return item.nonce;
  }
  return null;
}
