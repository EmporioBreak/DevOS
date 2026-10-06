import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState, StateStore } from "./orchestrator.js";
import { debugLog } from "./debug-log.js";
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
      const state = validateState(value);
      debugLog("state.load", { path: this.path, state });
      return state;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state: RunState): Promise<void> {
    const valid = validateState(state);
    debugLog("state.save", { path: this.path, state: valid });
    await mkdir(dirname(this.path), { recursive: true });

    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    debugLog("state.clear", { path: this.path });
    await rm(this.path, { force: true });
  }
}

function validateState(value: unknown): RunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid DevOS state");
  }

  const record = value as Record<string, unknown>;
  const task = record.task;
  const completionApproved = record.completionApproved;
  const mainAgentReviewPending = record.mainAgentReviewPending ?? record.ownerReviewPending;
  const browserWorkersStarted = record.browserWorkersStarted;
  const browserSessionRecovery = record.browserSessionRecovery;
  const sessionProjectRoots = record.sessionProjectRoots;

  if (completionApproved !== undefined && typeof completionApproved !== "boolean") throw new Error("Invalid DevOS state");
  if (completionApproved === true && mainAgentReviewPending === true) throw new Error("Invalid DevOS state");
  if (task !== undefined && !isTaskRef(task)) {
    throw new Error("Invalid DevOS state");
  }
  if (
    mainAgentReviewPending !== undefined &&
    typeof mainAgentReviewPending !== "boolean"
  ) {
    throw new Error("Invalid DevOS state");
  }
  if (sessionProjectRoots !== undefined && !isSessionMap(sessionProjectRoots)) {
    throw new Error("Invalid DevOS state");
  }
  if (
    browserWorkersStarted !== undefined &&
    !isWorkerIdList(browserWorkersStarted)
  ) {
    throw new Error("Invalid DevOS state");
  }
  if (
    browserSessionRecovery !== undefined &&
    !isWorkerIdList(browserSessionRecovery)
  ) {
    throw new Error("Invalid DevOS state");
  }

  if (
    Object.keys(record).some(
      key =>
        key !== "currentWorkerId" &&
        key !== "completedRuns" &&
        key !== "sessions" &&
        key !== "sessionProjectRoots" &&
        key !== "browserWorkersStarted" &&
        key !== "browserSessionRecovery" &&
        key !== "task" &&
        key !== "ownerReviewPending" &&
        key !== "mainAgentReviewPending" &&
        key !== "completionApproved",
    ) ||
    typeof record.currentWorkerId !== "string" ||
    !record.currentWorkerId.trim() ||
    typeof record.completedRuns !== "number" ||
    !Number.isSafeInteger(record.completedRuns) ||
    record.completedRuns < 0 ||
    !isSessionMap(record.sessions)
  ) {
    throw new Error("Invalid DevOS state");
  }

  return {
    currentWorkerId: record.currentWorkerId,
    completedRuns: record.completedRuns,
    sessions: { ...record.sessions },
    ...(sessionProjectRoots === undefined ? {} : { sessionProjectRoots: { ...sessionProjectRoots } }),
    ...(browserWorkersStarted === undefined
      ? {}
      : { browserWorkersStarted: [...browserWorkersStarted] }),
    ...(browserSessionRecovery === undefined
      ? {}
      : { browserSessionRecovery: [...browserSessionRecovery] }),
    ...(completionApproved === undefined ? {} : { completionApproved }),
    ...(task === undefined ? {} : { task }),
    ...(mainAgentReviewPending === undefined ? {} : { mainAgentReviewPending }),
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

function isWorkerIdList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(
      workerId => typeof workerId === "string" && workerId.trim().length > 0,
    )
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
