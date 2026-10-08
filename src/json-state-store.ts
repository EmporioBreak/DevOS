import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

    const temporaryPath = stateTemporaryPath(this.path, process.pid, randomUUID());
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
  const browserPreSubmitRetry = record.browserPreSubmitRetry;
  const activeReport = record.activeReport;
  const sessionProjectRoots = record.sessionProjectRoots;
  const startedAt = record.startedAt;
  const reviewLoops = record.reviewLoops;

  if (completionApproved !== undefined && typeof completionApproved !== "boolean") throw new Error("Invalid DevOS state");
  if (startedAt !== undefined && (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt)))) throw new Error("Invalid DevOS state");
  if (reviewLoops !== undefined && (typeof reviewLoops !== "number" || !Number.isSafeInteger(reviewLoops) || reviewLoops < 0)) throw new Error("Invalid DevOS state");
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

  if (browserPreSubmitRetry !== undefined && !isWorkerIdList(browserPreSubmitRetry)) {
    throw new Error("Invalid DevOS state");
  }

  if (activeReport !== undefined && (
    !activeReport || typeof activeReport !== "object" || Array.isArray(activeReport) ||
    Object.keys(activeReport).some(key => !["workerId", "turn", "tokenHash"].includes(key)) ||
    typeof (activeReport as Record<string, unknown>).workerId !== "string" ||
    !(activeReport as { workerId: string }).workerId.trim() ||
    !Number.isSafeInteger((activeReport as { turn?: unknown }).turn) ||
    (activeReport as { turn: number }).turn < 0 ||
    !/^[a-f0-9]{64}$/.test(String((activeReport as { tokenHash?: unknown }).tokenHash))
  )) throw new Error("Invalid DevOS active report");

  if (
    Object.keys(record).some(
      key =>
        key !== "currentWorkerId" &&
        key !== "completedRuns" &&
        key !== "sessions" &&
        key !== "sessionProjectRoots" &&
        key !== "browserWorkersStarted" &&
        key !== "browserSessionRecovery" &&
        key !== "browserPreSubmitRetry" &&
        key !== "activeReport" &&
        key !== "task" &&
        key !== "ownerReviewPending" &&
        key !== "mainAgentReviewPending" &&
        key !== "completionApproved" &&
        key !== "startedAt" &&
        key !== "reviewLoops",
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
    ...(browserPreSubmitRetry === undefined
      ? {}
      : { browserPreSubmitRetry: [...browserPreSubmitRetry] }),
    ...(activeReport === undefined ? {} : { activeReport: { ...(activeReport as { workerId: string; turn: number; tokenHash: string }) } }),
    ...(completionApproved === undefined ? {} : { completionApproved }),
    ...(task === undefined ? {} : { task }),
    ...(mainAgentReviewPending === undefined ? {} : { mainAgentReviewPending }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(reviewLoops === undefined ? {} : { reviewLoops }),
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


export function stateTemporaryPath(
  path: string,
  pid: number,
  nonce: string,
): string {
  return `${path}.tmp.${pid}.${nonce}`;
}
