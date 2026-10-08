import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REGISTRY_VERSION = 1;
const KEY_BYTES = 32;
const MAX_OPAQUE_ID = 512;

export interface HostConversationIdentity {
  session: string;
  subject?: string;
  organization?: string;
  source: "meta" | "header";
}

export interface ConversationIdentityRecord {
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  route?: string;
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

  const metaSession = opaque(record?.["openai/session"]);
  if (metaSession) {
    const subject = opaque(record?.["openai/subject"]);
    const organization = opaque(record?.["openai/organization"]);
    return {
      session: metaSession,
      ...(subject ? { subject } : {}),
      ...(organization ? { organization } : {}),
      source: "meta",
    };
  }

  const session = header(headers, "x-openai-session");
  if (!session) return undefined;
  const subject = header(headers, "x-openai-subject");
  const organization = header(headers, "x-openai-organization");
  return {
    session,
    ...(subject ? { subject } : {}),
    ...(organization ? { organization } : {}),
    source: "header",
  };
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
        typeof record.lastSeenAt !== "string" ||
        (record.route !== undefined && typeof record.route !== "string")
      ) {
        throw new Error("Invalid conversation identity registry");
      }
      parsed.push({
        fingerprint: record.fingerprint,
        firstSeenAt: record.firstSeenAt,
        lastSeenAt: record.lastSeenAt,
        ...(typeof record.route === "string" ? { route: record.route } : {}),
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
