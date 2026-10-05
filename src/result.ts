import type { DevosResult, WorkerStatus } from "./workflow.js";

const PREFIX = "DEVOS_RESULT ";
const STATUSES = new Set<WorkerStatus>([
  "done",
  "approved",
  "changes_requested",
  "needs_host",
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
  if (keys.some((key) => key !== "status")) {
    throw new Error("DEVOS_RESULT contains unsupported fields");
  }

  if (typeof value.status !== "string" || !STATUSES.has(value.status as WorkerStatus)) {
    throw new Error("DEVOS_RESULT has invalid status");
  }

  return { status: value.status as WorkerStatus };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
