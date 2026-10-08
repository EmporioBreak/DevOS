import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REGISTRY_VERSION = 1;
const KEY_BYTES = 32;
const MAX_OPAQUE_ID = 512;
const MAX_CONVERSATIONS = 512;

export interface HostConversationIdentity {
  session: string;
  source: "meta" | "header";
}

export interface ConversationIdentityRecord {
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface ConversationIdentityRegistry {
  version: 1;
  conversations: ConversationIdentityRecord[];
}

type HeaderBag = Record<string, string | string[] | undefined>;

function opaque(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_OPAQUE_ID || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

function header(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return opaque(Array.isArray(direct) ? direct[0] : direct);
}

export function extractHostConversationIdentity(
  request: unknown,
  headers?: HeaderBag,
): HostConversationIdentity | undefined {
  const params =
    request && typeof request === "object" && !Array.isArray(request)
      ? (request as { params?: unknown }).params
      : undefined;
  const meta =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as { _meta?: unknown })._meta
      : undefined;
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined;

  const hasMetaSession =
    !!record && Object.prototype.hasOwnProperty.call(record, "openai/session");
  if (hasMetaSession) {
    const metaSession = opaque(record?.["openai/session"]);
    if (!metaSession) return undefined;
    const headerSession = header(headers, "x-openai-session");
    if (headerSession && headerSession !== metaSession) return undefined;
    return { session: metaSession, source: "meta" };
  }

  const session = header(headers, "x-openai-session");
  return session ? { session, source: "header" } : undefined;
}

export function conversationIdentityFingerprint(
  identity: HostConversationIdentity,
  key: Buffer,
): string {
  return "chatgpt-session-v1_" +
    createHmac("sha256", key)
      .update("devos-chatgpt-session-v1\0")
      .update(identity.session)
      .digest("base64url");
}

async function readOrCreateKey(root: string): Promise<Buffer> {
  const path = join(root, ".devos", "connector", "conversation-identity.key");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (existing.length !== KEY_BYTES) throw new Error("Invalid conversation identity key");
    return existing;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const key = randomBytes(KEY_BYTES);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(key.toString("base64url") + "\n", "utf8");
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = Buffer.from((await readFile(path, "utf8")).trim(), "base64url");
    if (existing.length !== KEY_BYTES) throw new Error("Invalid conversation identity key");
    return existing;
  }
}

async function readRegistry(path: string): Promise<ConversationIdentityRegistry> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as { version?: unknown }).version !== REGISTRY_VERSION ||
      !Array.isArray((value as { conversations?: unknown }).conversations)
    ) {
      throw new Error("Invalid conversation identity registry");
    }
    const conversations = (value as { conversations: unknown[] }).conversations;
    const parsed: ConversationIdentityRecord[] = [];
    for (const item of conversations) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Invalid conversation identity registry");
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.fingerprint !== "string" ||
        typeof record.firstSeenAt !== "string" ||
        typeof record.lastSeenAt !== "string"
      ) {
        throw new Error("Invalid conversation identity registry");
      }
      parsed.push({
        fingerprint: record.fingerprint,
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
      });
    }
    return { version: 1, conversations: parsed };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, conversations: [] };
    }
    throw error;
  }
}

let registryWrites: Promise<void> = Promise.resolve();

async function recordHostConversationIdentityNow(
  root: string,
  identity: HostConversationIdentity,
  now: Date,
): Promise<ConversationIdentityRecord> {
  const key = await readOrCreateKey(root);
  const fingerprint = conversationIdentityFingerprint(identity, key);
  const path = join(root, ".devos", "conversation-identities.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const registry = await readRegistry(path);
  const at = now.toISOString();
  const existing = registry.conversations.find(item => item.fingerprint === fingerprint);
  const record = existing ?? { fingerprint, firstSeenAt: at, lastSeenAt: at };
  record.lastSeenAt = at;
  if (!existing) registry.conversations.push(record);
  registry.conversations.sort((left, right) =>
    right.lastSeenAt.localeCompare(left.lastSeenAt),
  );
  if (registry.conversations.length > MAX_CONVERSATIONS) {
    registry.conversations.length = MAX_CONVERSATIONS;
  }

  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  return { ...record };
}

export async function recordHostConversationIdentity(
  root: string,
  identity: HostConversationIdentity,
  now = new Date(),
): Promise<ConversationIdentityRecord> {
  let resolveRecord!: (value: ConversationIdentityRecord) => void;
  let rejectRecord!: (error: unknown) => void;
  const result = new Promise<ConversationIdentityRecord>((resolve, reject) => {
    resolveRecord = resolve;
    rejectRecord = reject;
  });
  registryWrites = registryWrites.then(async () => {
    try {
      resolveRecord(await recordHostConversationIdentityNow(root, identity, now));
    } catch (error) {
      rejectRecord(error);
    }
  });
  return result;
}

export type ConversationIdentityObservation =
  | { status: "recorded"; record: ConversationIdentityRecord }
  | { status: "unresolved" }
  | { status: "tool_error" };

export async function observeSuccessfulToolConversationIdentity(
  root: string,
  request: unknown,
  result: unknown,
  headers?: HeaderBag,
  now = new Date(),
): Promise<ConversationIdentityObservation> {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    (result as { isError?: unknown }).isError === true
  ) {
    return { status: "tool_error" };
  }
  const identity = extractHostConversationIdentity(request, headers);
  if (!identity) return { status: "unresolved" };
  return {
    status: "recorded",
    record: await recordHostConversationIdentity(root, identity, now),
  };
}
