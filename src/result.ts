import type { DevosResult, WorkerStatus } from "./workflow.js";

const PREFIX = "DEVOS_RESULT ";
const STATUSES = new Set<WorkerStatus>([
  "done",
  "approved",
  "changes_requested",
  "failed",
]);

export function parseDevosResult(output: string): DevosResult {
  const lines = output.trimEnd().split(/\r?\n/);
  const last = lines.at(-1)?.trim();

  if (!last?.startsWith(PREFIX)) {
    throw new Error("Worker did not end with DEVOS_RESULT");
  }

  let value: unknown;
  try {
    value = JSON.parse(last.slice(PREFIX.length));
  } catch {
    throw new Error("DEVOS_RESULT is not valid JSON");
  }

  if (!isRecord(value)) {
    throw new Error("DEVOS_RESULT must be an object");
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== "status" && key !== "next")) {
    throw new Error("DEVOS_RESULT contains unsupported fields");
  }

  if (typeof value.status !== "string" || !STATUSES.has(value.status as WorkerStatus)) {
    throw new Error("DEVOS_RESULT has invalid status");
  }

  if (
    value.next !== undefined &&
    (typeof value.next !== "string" || !value.next.trim())
  ) {
    throw new Error("DEVOS_RESULT has invalid next worker");
  }

  return value.next === undefined
    ? { status: value.status as WorkerStatus }
    : { status: value.status as WorkerStatus, next: value.next };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
