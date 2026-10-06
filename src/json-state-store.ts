import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState, StateStore } from "./orchestrator.js";
import type { TaskRef } from "./workflow.js";

export class JsonStateStore implements StateStore {
  readonly path: string;

  constructor(projectRoot: string, task: TaskRef) {
    this.path = join(
      projectRoot,
      ".devos",
      "state",
      `${encodeURIComponent(task.repo)}-issue-${task.issue}.json`,
    );
  }

  async load(): Promise<RunState | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      const value: unknown = JSON.parse(raw);
      return validateState(value);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state: RunState): Promise<void> {
    const valid = validateState(state);
    await mkdir(dirname(this.path), { recursive: true });

    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function validateState(value: unknown): RunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid DevOS state");
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      key =>
        key !== "currentWorkerId" &&
        key !== "completedRuns" &&
        key !== "sessions" &&
        key !== "task" &&
        key !== "ownerReviewPending",
    ) ||
    typeof record.currentWorkerId !== "string" ||
    !record.currentWorkerId.trim() ||
    typeof record.completedRuns !== "number" ||
    !Number.isSafeInteger(record.completedRuns) ||
    record.completedRuns < 0 ||
    !isSessionMap(record.sessions) ||
    (record.task !== undefined && !isTaskRef(record.task)) ||
    (record.ownerReviewPending !== undefined &&
      typeof record.ownerReviewPending !== "boolean")
  ) {
    throw new Error("Invalid DevOS state");
  }

  return {
    currentWorkerId: record.currentWorkerId,
    completedRuns: record.completedRuns,
    sessions: { ...record.sessions },
    ...(record.task === undefined ? {} : { task: { ...record.task } }),
    ...(record.ownerReviewPending === undefined
      ? {}
      : { ownerReviewPending: record.ownerReviewPending }),
  };
}

function isTaskRef(value: unknown): value is TaskRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(
      key => key === "repo" || key === "issue" || key === "pr",
    ) &&
    typeof record.repo === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(record.repo) &&
    typeof record.issue === "number" &&
    Number.isSafeInteger(record.issue) &&
    record.issue > 0 &&
    (record.pr === undefined ||
      (typeof record.pr === "number" &&
        Number.isSafeInteger(record.pr) &&
        record.pr > 0))
  );
}

function isSessionMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([workerId, sessionId]) =>
      workerId.trim().length > 0 &&
      typeof sessionId === "string" &&
      sessionId.trim().length > 0,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
