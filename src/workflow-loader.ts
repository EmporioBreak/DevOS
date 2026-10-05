import { readFile } from "node:fs/promises";
import type { ExecutorKind, WorkerSpec, WorkerStatus, Workflow } from "./workflow.js";

const EXECUTORS = new Set<ExecutorKind>(["codex", "chatgpt_browser"]);
const STATUSES = new Set<WorkerStatus>([
  "done",
  "approved",
  "changes_requested",
  "needs_host",
  "failed",
]);

export async function loadWorkflow(path: string): Promise<Workflow> {
  const raw = await readFile(path, "utf8");
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Workflow is not valid JSON: ${path}`);
  }

  return parseWorkflow(value);
}

export function parseWorkflow(value: unknown): Workflow {
  const record = asRecord(value, "Workflow");

  if (record.version !== 1) {
    throw new Error("Workflow version must equal 1");
  }

  const task = asRecord(record.task, "Workflow task");
  const repo = requireNonEmptyString(task.repo, "Workflow task repo");
  const issue = requirePositiveInteger(task.issue, "Workflow task issue");
  const pr =
    task.pr === undefined
      ? undefined
      : requirePositiveInteger(task.pr, "Workflow task pr");

  const start = requireNonEmptyString(record.start, "Workflow start");

  if (!Array.isArray(record.workers) || record.workers.length === 0) {
    throw new Error("Workflow workers must be a non-empty array");
  }

  const workers = record.workers.map(parseWorker);
  const ids = new Set<string>();

  for (const worker of workers) {
    if (ids.has(worker.id)) {
      throw new Error(`Duplicate worker id: ${worker.id}`);
    }
    ids.add(worker.id);
  }

  if (!ids.has(start)) {
    throw new Error(`Workflow start references unknown worker: ${start}`);
  }

  for (const worker of workers) {
    for (const next of Object.values(worker.on)) {
      if (typeof next === "string" && !ids.has(next)) {
        throw new Error(`Worker ${worker.id} routes to unknown worker: ${next}`);
      }
    }
  }

  return {
    version: 1,
    task: {
      repo,
      issue,
      ...(pr === undefined ? {} : { pr }),
    },
    start,
    workers,
  };
}

function parseWorker(value: unknown): WorkerSpec {
  const record = asRecord(value, "Worker");
  const id = requireNonEmptyString(record.id, "Worker id");
  const executor = requireNonEmptyString(record.executor, `Worker ${id} executor`);

  if (!EXECUTORS.has(executor as ExecutorKind)) {
    throw new Error(`Worker ${id} has unsupported executor: ${executor}`);
  }

  const prompt = requireNonEmptyString(record.prompt, `Worker ${id} prompt`);
  const onRecord = asRecord(record.on, `Worker ${id} routes`);
  const on: Partial<Record<WorkerStatus, string | null>> = {};

  for (const [status, next] of Object.entries(onRecord)) {
    if (!STATUSES.has(status as WorkerStatus)) {
      throw new Error(`Worker ${id} has unsupported status route: ${status}`);
    }

    if (next !== null && (typeof next !== "string" || !next.trim())) {
      throw new Error(`Worker ${id} has invalid route for ${status}`);
    }

    on[status as WorkerStatus] = next as string | null;
  }

  return {
    id,
    executor: executor as ExecutorKind,
    prompt,
    on,
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
