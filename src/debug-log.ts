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
    return value
      .replace(/(authorization:\\s*bearer\\s+)[^\\s]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:token|auth|key)=)[^&\\s]+/gi, "$1[REDACTED]");
  }
  return value;
}
