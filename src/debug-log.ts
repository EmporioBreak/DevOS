import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function debugEnabled(): boolean {
  return process.env.DEVOS_DEBUG === "1" && !!process.env.DEVOS_DEBUG_FILE;
}

export function debugLog(event: string, data: unknown): void {
  const file = process.env.DEVOS_DEBUG_FILE;
  if (!debugEnabled() || !file) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({
    at: new Date().toISOString(),
    event,
    data: redact(data),
  }) + "\n", { encoding: "utf8", mode: 0o600 });
}

function redact(value: unknown, key = ""): unknown {
  if (/token|cookie|password|secret|authorization|private.?key/i.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]),
    );
  }
  if (typeof value === "string") {
    return redactSerializedCredentials(value)
      .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator: string, key: string) =>
        isCredentialQueryKey(key) ? `${separator}${key}=[REDACTED]` : match,
      );
  }
  return value;
}

function redactSerializedCredentials(value: string): string {
  let redacted = value.replace(
    /"([^"\\]+)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    (match, key: string) => isCredentialQueryKey(key)
      ? match.replace(/:\s*"[^"]*"/, ': "[REDACTED]"')
      : match,
  );

  redacted = redacted.replace(
    /\\\"([^"\\]+)\\\"\s*:\s*\\\"((?:\\\\.|[^"\\])*)\\\"/g,
    (match, key: string) => isCredentialQueryKey(key)
      ? match.replace(/:\s*\\\".*\\\"$/, ':\\\"[REDACTED]\\\"')
      : match,
  );
  return redacted;
}

function isCredentialQueryKey(key: string): boolean {
  let decodedKey = key;
  try {
    decodedKey = decodeURIComponent(key);
  } catch {
    // Keep malformed query keys intact; normalize the readable characters below.
  }
  const normalized = decodedKey
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /(?:^|[_-])(?:token|secret|password|credential|authorization|auth|key|cookie)(?:[_-]|$)/.test(
    normalized,
  );
}
