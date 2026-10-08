import {
  isBrowserPreSubmitFailureError,
  isBrowserResumeUnavailableError,
} from "./chatgpt-browser-executor.js";
import { isCodexResumeUnavailableError } from "./codex-executor.js";
import type { Executor } from "./executor.js";
import { randomBytes } from "node:crypto";
import { DevosToolRegistry, reportTokenHash } from "./mcp-tools/registry.js";
import { parseDevosResult } from "./result.js";
import type { ExecutorKind, TaskRef, WorkerOutput, WorkerStatus, Workflow, WorkerSpec } from "./workflow.js";

export interface WorkerReportTurn {
  workerId: string;
  turn: number;
  tokenHash: string;
}

export interface RunState {
  currentWorkerId: string;
  completedRuns: number;
  sessions: Record<string, string>;
  sessionProjectRoots?: Record<string, string>;
  browserWorkersStarted?: string[];
  browserSessionRecovery?: string[];
  browserPreSubmitRetry?: string[];
  activeReport?: WorkerReportTurn;
  task?: TaskRef;
  mainAgentReviewPending?: boolean;
  completionApproved?: boolean;
  startedAt?: string;
  reviewLoops?: number;
}

export interface StateStore {
  load(): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  clear(): Promise<void>;
}

export type TaskLifecycleStatus =
  | "ready"
  | "running"
  | "final_review_required"
  | "changes_requested"
  | "completed"
  | "blocked"
  | "failed";

export type OrchestrationEvent =
  | {
      type: "task_status";
      task: TaskRef;
      status: TaskLifecycleStatus;
      resumed?: boolean;
    }
  | {
      type: "worker_started";
      workerId: string;
      executor: ExecutorKind;
      session: "fresh" | "resumed";
    }
  | {
      type: "worker_result";
      workerId: string;
      executor: ExecutorKind;
      status: WorkerStatus;
    }
  | { type: "transition"; from: string; to: string }
  | { type: "worker_session_recovered"; workerId: string; executor: ExecutorKind; reason: string }
  | { type: "main_agent_handoff"; task: TaskRef };

export interface OrchestratorOptions {
  projectRoot: string;
  workflow: Workflow;
  executors: Map<string, Executor>;
  stateStore: StateStore;
  mainAgentDecision?: "approved" | "changes_requested";
  finalizeTask?: (state: RunState) => Promise<void>;
  resolveTask?: (task: TaskRef) => Promise<TaskRef>;
  onEvent?: (event: OrchestrationEvent) => void | Promise<void>;
  enableWorkerReports?: boolean;
  maxWorkerRuns?: number;
  maxReviewLoops?: number;
  maxWallClockDurationMs?: number;
  now?: () => number;
}

export class Orchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  async run(): Promise<RunState> {
    const { workflow, stateStore } = this.options;
    const workers = new Map(workflow.workers.map((worker) => [worker.id, worker]));
    const persistedState = await stateStore.load();
    let state =
      persistedState ?? {
        currentWorkerId: workflow.start,
        completedRuns: 0,
        sessions: {},
        task: workflow.task,
        startedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
        reviewLoops: 0,
      };

    if (!state.startedAt || state.reviewLoops === undefined) {
      state = {
        ...state,
        startedAt: state.startedAt ?? new Date((this.options.now ?? Date.now)()).toISOString(),
        reviewLoops: state.reviewLoops ?? 0,
      };
      if (persistedState) await stateStore.save(state);
    }

    if (!state.task || workflow.task.pr !== undefined) {
      state = { ...state, task: workflow.task };
      if (persistedState) await stateStore.save(state);
    }

    if (state.completionApproved) {
      if (this.options.mainAgentDecision === "changes_requested") {
        throw new Error("DEVOS_OWNER_RESULT requires an existing task waiting for final review");
      }
      return await this.finishApproved(state);
    }

    if (this.options.mainAgentDecision && !state.mainAgentReviewPending) {
      throw new Error("DEVOS_OWNER_RESULT requires an existing task waiting for final review");
    }
    if (state.mainAgentReviewPending) {
      const decision = this.options.mainAgentDecision;
      if (!decision) {
        await this.emit({
          type: "main_agent_handoff",
          task: state.task ?? workflow.task,
        });
        await this.emitTaskStatus(state, "final_review_required");
        return state;
      }

      if (decision === "approved") {
        return await this.finishApproved(state);
      }

      await this.emitTaskStatus(state, "changes_requested");
      state = {
        currentWorkerId: workflow.start,
        completedRuns: state.completedRuns,
        startedAt: state.startedAt ?? new Date((this.options.now ?? Date.now)()).toISOString(),
        reviewLoops: (state.reviewLoops ?? 0) + 1,
        sessions: state.sessions,
        ...(state.sessionProjectRoots ? { sessionProjectRoots: state.sessionProjectRoots } : {}),
        ...(state.browserWorkersStarted
          ? { browserWorkersStarted: state.browserWorkersStarted }
          : {}),
        ...(state.browserSessionRecovery
          ? { browserSessionRecovery: state.browserSessionRecovery }
          : {}),
        ...(state.browserPreSubmitRetry
          ? { browserPreSubmitRetry: state.browserPreSubmitRetry }
          : {}),
        task: state.task ?? workflow.task,
      };
      await stateStore.save(state);
      await this.emit({ type: "transition", from: "main_agent", to: workflow.start });
      await this.emitTaskStatus(state, "running", true);
    } else {
      await this.emitTaskStatus(state, "running", persistedState !== null);
    }

    while (true) {
      await this.assertBudgets(state);
      const worker = workers.get(state.currentWorkerId);
      if (!worker) throw new Error(`Unknown worker: ${state.currentWorkerId}`);

      const executor = this.options.executors.get(worker.executor);
      if (!executor) throw new Error(`Missing executor: ${worker.executor}`);

      // A previous process may have died after the MCP report was committed
      // but before it advanced task state. Consume that exact durable report,
      // never send the same prompt again. No report means unresolved delivery:
      // fail closed unless an earlier attempt was proven pre-submit.
      let recoveredReportStatus: WorkerStatus | null = null;
      if (state.activeReport && !state.browserPreSubmitRetry?.includes(worker.id)) {
        const active = state.activeReport;
        if (worker.executor !== "chatgpt_browser" ||
            active.workerId !== worker.id || active.turn !== state.completedRuns)
          throw new Error("Previous DevOS worker report identity mismatched task state");
        const reported = await new DevosToolRegistry(this.options.projectRoot)
          .readReport(state.task ?? workflow.task, active);
        if (!reported || !state.sessions[worker.id]) {
          throw new Error(`Unresolved prior browser turn for ${worker.id}: no verified terminal MCP report and saved conversation; refusing prompt replay`);
        }
        recoveredReportStatus = reported;
      }

      let sessionId = state.sessions[worker.id];
      if (
        worker.executor === "codex" &&
        sessionId &&
        state.sessionProjectRoots?.[worker.id] !== this.options.projectRoot
      ) {
        const sessions = { ...state.sessions };
        const sessionProjectRoots = { ...(state.sessionProjectRoots ?? {}) };
        delete sessions[worker.id];
        delete sessionProjectRoots[worker.id];
        state = { ...state, sessions, sessionProjectRoots };
        sessionId = undefined;
        await stateStore.save(state);
        await this.emit({
          type: "worker_session_recovered",
          workerId: worker.id,
          executor: worker.executor,
          reason: "saved Codex session belongs to a different project root",
        });
      }
      const browserWorkerAlreadyStarted =
        worker.executor === "chatgpt_browser" &&
        state.browserWorkersStarted?.includes(worker.id) === true;
      const browserPreSubmitRetryPending =
        worker.executor === "chatgpt_browser" &&
        state.browserPreSubmitRetry?.includes(worker.id) === true;
      if (browserWorkerAlreadyStarted && !sessionId && !browserPreSubmitRetryPending) {
        await stateStore.save(state);
        throw new Error(
          `Missing saved browser session for previously started worker: ${worker.id}`,
        );
      }
      if (worker.executor === "chatgpt_browser" && !browserWorkerAlreadyStarted) {
        state = {
          ...state,
          browserWorkersStarted: [
            ...(state.browserWorkersStarted ?? []),
            worker.id,
          ],
        };
        await stateStore.save(state);
      }

      if (browserPreSubmitRetryPending) {
        // Consume durably before another attempt can submit. If the process
        // stops without a classified outcome, ordinary run must fail closed.
        // Only a newly proven pre-submit failure below can restore permission.
        state = { ...state, browserPreSubmitRetry: state.browserPreSubmitRetry!.filter(id => id !== worker.id) };
        await stateStore.save(state);
      }

      if (!recoveredReportStatus) await this.emit({
        type: "worker_started",
        workerId: worker.id,
        executor: worker.executor,
        session: sessionId ? "resumed" : "fresh",
      });
      const activeWorkflow = { ...workflow, task: state.task ?? workflow.task };
      // One capability per browser turn; only its hash is persisted and the
      // report cannot be replayed after a task restart or subsequent turn.
      // Persist one opaque attempt identity for EVERY browser turn, even if
      // MCP is disabled. Otherwise a lost no-MCP SSE result could be replayed
      // on the next CLI run. Only disclose the token when reporting is enabled.
      const browserTurnToken = worker.executor === "chatgpt_browser" &&
        !recoveredReportStatus ? randomBytes(32).toString("hex") : undefined;
      const workerReportToken = this.options.enableWorkerReports ? browserTurnToken : undefined;
      if (browserTurnToken) {
        state = {
          ...state,
          activeReport: {
            workerId: worker.id,
            turn: state.completedRuns,
            tokenHash: reportTokenHash(browserTurnToken),
          },
        };
        await stateStore.save(state);
      }
      let notifySessionSaved!: () => void;
      const sessionSaved = new Promise<void>(resolve => { notifySessionSaved = resolve; });
      const onSession = async (reportedSessionId: string) => {
        state = {
          ...state,
          sessions: { ...state.sessions, [worker.id]: reportedSessionId },
          ...(worker.executor === "codex" ? { sessionProjectRoots: { ...(state.sessionProjectRoots ?? {}), [worker.id]: this.options.projectRoot } } : {}),
          ...(state.browserSessionRecovery ? { browserSessionRecovery: state.browserSessionRecovery.filter(id => id !== worker.id) } : {}),
          ...(state.browserPreSubmitRetry ? { browserPreSubmitRetry: state.browserPreSubmitRetry.filter(id => id !== worker.id) } : {}),
        };
        await stateStore.save(state);
        notifySessionSaved();
      };
      let output: WorkerOutput;
      try {
        const knownBrowserSessions = worker.executor === "chatgpt_browser"
          ? Object.fromEntries(
              Object.entries(state.sessions).filter(
                ([workerId]) => workers.get(workerId)?.executor === "chatgpt_browser",
              ),
            )
          : undefined;
        if (recoveredReportStatus) {
          output = { text: "", sessionId: state.sessions[worker.id]! };
        } else {
        const executing = executor.run({
          projectRoot: this.options.projectRoot,
          prompt: buildWorkerPrompt(activeWorkflow, worker, this.options.projectRoot,
            workerReportToken ? { turn: state.completedRuns, token: workerReportToken } : undefined) +
            (browserTurnToken
              ? "\n\nDevOS browser attempt ID: " + state.activeReport!.tokenHash + ". This is a non-secret correlation identifier; do not repeat it in your final answer or GitHub comments."
              : ""),
          workerId: worker.id,
          ...(worker.executor === "chatgpt_browser"
            ? {
                knownBrowserSessions: knownBrowserSessions!,
                browserTurnId: `${state.completedRuns}:${worker.id}${browserTurnToken ? ":" + state.activeReport!.tokenHash : ""}`,
                ...(workerReportToken ? {
                  allowToolReportedStatus: true,
                  reportTurn: { task: activeWorkflow.task, active: state.activeReport! },
                } : {}),
              }
            : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(worker.executor === "chatgpt_browser" ? { enforceProjectScope: true } : {}),
          onSession,
        });
        // The MCP report is a control-plane terminal event. Observe it in
        // Orchestrator itself, independently of the browser process/SSE.
        output = state.activeReport && workerReportToken
          ? await awaitWorkerReportOrBrowser({
              browser: executing,
              registry: new DevosToolRegistry(this.options.projectRoot),
              task: activeWorkflow.task,
              active: state.activeReport,
              getSession: () => state.sessions[worker.id],
              sessionSaved,
            })
          : await executing;
        }
      } catch (error) {
        if (worker.executor === "codex" && sessionId && isCodexResumeUnavailableError(error)) {
          const sessions = { ...state.sessions };
          const sessionProjectRoots = { ...(state.sessionProjectRoots ?? {}) };
          delete sessions[worker.id];
          delete sessionProjectRoots[worker.id];
          state = { ...state, sessions, sessionProjectRoots };
          await stateStore.save(state);
          await this.emit({
            type: "worker_session_recovered",
            workerId: worker.id,
            executor: worker.executor,
            reason: error.message,
          });
          output = await executor.run({
            projectRoot: this.options.projectRoot,
            prompt: buildWorkerPrompt(activeWorkflow, worker, this.options.projectRoot),
            onSession,
          });
        } else if (
          worker.executor === "chatgpt_browser" && sessionId &&
          isBrowserResumeUnavailableError(error)
        ) {
          // BrowserResumeUnavailableError is classified *before* any possible
          // DOM submit. Preserve the previously validated conversation, but
          // retire the unused one-turn capability so explicit retry is safe.
          const { activeReport: _unusedCapability, ...safeState } = state;
          state = safeState;
          await stateStore.save(state);
          throw error;
        } else if (
          worker.executor === "chatgpt_browser" &&
          !sessionId &&
          isBrowserPreSubmitFailureError(error)
        ) {
          const { activeReport: _abortedBeforeSubmit, ...safeState } = state;
          state = {
            ...safeState,
            browserPreSubmitRetry: [
              ...(state.browserPreSubmitRetry ?? []).filter(id => id !== worker.id),
              worker.id,
            ],
          };
          await stateStore.save(state);
          throw error;
        } else {
          if (
            worker.executor === "chatgpt_browser" &&
            !sessionId &&
            state.browserPreSubmitRetry?.includes(worker.id)
          ) {
            state = {
              ...state,
              browserPreSubmitRetry: state.browserPreSubmitRetry.filter(id => id !== worker.id),
            };
            await stateStore.save(state);
          }
          throw error;
        }
      }

      if (output.sessionId !== undefined) await onSession(output.sessionId);
      const sessions = state.sessions;
      const sessionProjectRoots = state.sessionProjectRoots;
      const reportedStatus = state.activeReport && (workerReportToken || recoveredReportStatus)
        ? await new DevosToolRegistry(this.options.projectRoot).readReport(activeWorkflow.task, state.activeReport)
        : null;
      if (worker.executor === "chatgpt_browser" && this.options.enableWorkerReports &&
          !reportedStatus) throw new Error("Browser worker missing required devos_worker_report; status cannot be inferred from text");
      let parsed: ReturnType<typeof parseDevosResult> | undefined;
      try {
        parsed = worker.executor === "chatgpt_browser" && this.options.enableWorkerReports
          ? undefined : parseDevosResult(output.text);
      } catch (error) {
        // A present but invalid/malformed final marker must never be silently
        // overridden by a tool report. Only a missing marker may fall back.
        if (!reportedStatus || output.text.includes("DEVOS_RESULT"))
          throw error;
      }
      if (parsed && reportedStatus && parsed.status !== reportedStatus)
        throw new Error(`Worker ${worker.id} reported conflicting statuses via MCP and final message`);
      const result = parsed ?? { status: reportedStatus! };
      if (worker.executor === "codex" && result.status === "needs_local_worker") {
        state = { ...state, sessions, ...(sessionProjectRoots ? { sessionProjectRoots } : {}) };
        await stateStore.save(state);
        await this.emitTaskStatus(state, "failed");
        throw new Error(
          `Worker ${worker.id} uses codex and cannot return needs_local_worker`,
        );
      }
      const { activeReport: _completedReport, ...completedState } = state;
      state = {
        ...completedState,
        sessions,
        ...(sessionProjectRoots ? { sessionProjectRoots } : {}),
        completedRuns: state.completedRuns + 1,
        ...(result.status === "changes_requested"
          ? { reviewLoops: (state.reviewLoops ?? 0) + 1 }
          : {}),
      };
      await this.emit({
        type: "worker_result",
        workerId: worker.id,
        executor: worker.executor,
        status: result.status,
      });

      if (result.status === "failed") {
        await stateStore.save(state);
        await this.emitTaskStatus(state, "failed");
        throw new Error(`Worker failed: ${worker.id}`);
      }

      const nextWorkerId = worker.on[result.status];

      if (
        (result.status === "needs_local_worker" || result.status === "changes_requested") &&
        (nextWorkerId === null || nextWorkerId === undefined)
      ) {
        await stateStore.save(state);
        await this.emitTaskStatus(state, "blocked");
        throw new Error(
          `Worker ${worker.id} returned unroutable status: ${result.status}`,
        );
      }

      if (nextWorkerId === null || nextWorkerId === undefined) {
        if (
          workflow.owner &&
          state.task?.pr === undefined &&
          this.options.resolveTask
        ) {
          const task = await this.options.resolveTask(state.task ?? workflow.task);
          state = { ...state, task };
          await stateStore.save(state);
        }

        if (workflow.owner) {
          await this.emit({
            type: "main_agent_handoff",
            task: state.task ?? workflow.task,
          });
        }
        const ownerResult = workflow.owner ? "final_review_required" : "approved";
        if (ownerResult === "approved") {
          return await this.finishApproved(state);
        }

        if (ownerResult === "final_review_required") {
          state = { ...state, mainAgentReviewPending: true };
          await stateStore.save(state);
          await this.emitTaskStatus(state, "final_review_required");
          return state;
        }

        await this.emitTaskStatus(state, "changes_requested");
        state = {
          currentWorkerId: workflow.start,
          completedRuns: state.completedRuns,
          startedAt: state.startedAt ?? new Date((this.options.now ?? Date.now)()).toISOString(),
          reviewLoops: state.reviewLoops ?? 0,
          sessions: state.sessions,
          ...(state.sessionProjectRoots ? { sessionProjectRoots: state.sessionProjectRoots } : {}),
          ...(state.browserWorkersStarted
            ? { browserWorkersStarted: state.browserWorkersStarted }
            : {}),
          ...(state.browserSessionRecovery
            ? { browserSessionRecovery: state.browserSessionRecovery }
            : {}),
          ...(state.browserPreSubmitRetry
            ? { browserPreSubmitRetry: state.browserPreSubmitRetry }
            : {}),
          task: state.task ?? workflow.task,
        };
        await stateStore.save(state);
        await this.emit({ type: "transition", from: "main_agent", to: workflow.start });
        await this.emitTaskStatus(state, "running", true);
        continue;
      }

      if (!workers.has(nextWorkerId)) {
        throw new Error(`Worker ${worker.id} routed to unknown worker: ${nextWorkerId}`);
      }

      await this.emit({ type: "transition", from: worker.id, to: nextWorkerId });
      state = { ...state, currentWorkerId: nextWorkerId };
      await stateStore.save(state);
    }
  }

  private async assertBudgets(state: RunState): Promise<void> {
    const maxWorkerRuns = this.options.maxWorkerRuns ?? 30;
    const maxReviewLoops = this.options.maxReviewLoops ?? 8;
    const maxWallClockDurationMs = this.options.maxWallClockDurationMs ?? 6 * 60 * 60_000;
    const now = this.options.now ?? Date.now;
    let failure: string | undefined;
    if (state.completedRuns >= maxWorkerRuns) {
      failure = `DevOS orchestration exceeded maxWorkerRuns=${maxWorkerRuns}`;
    } else if ((state.reviewLoops ?? 0) > maxReviewLoops) {
      failure = `DevOS orchestration exceeded maxReviewLoops=${maxReviewLoops}`;
    } else if (state.startedAt && now() - Date.parse(state.startedAt) > maxWallClockDurationMs) {
      failure = `DevOS orchestration exceeded maxWallClockDurationMs=${maxWallClockDurationMs}`;
    }
    if (!failure) return;
    await this.options.stateStore.save(state);
    await this.emitTaskStatus(state, "failed");
    throw new Error(failure);
  }

  private async finishApproved(state: RunState): Promise<RunState> {
    const approved = { ...state, mainAgentReviewPending: false, completionApproved: true };
    // Keep approval and sessions until both marker writing and state cleanup succeed.
    await this.options.stateStore.save(approved);
    await this.options.finalizeTask?.(approved);
    await this.options.stateStore.clear();
    await this.emitTaskStatus(approved, "completed");
    return approved;
  }

  private async emit(event: OrchestrationEvent): Promise<void> {
    await this.options.onEvent?.(event);
  }

  private async emitTaskStatus(
    state: RunState,
    status: TaskLifecycleStatus,
    resumed?: boolean,
  ): Promise<void> {
    await this.emit({
      type: "task_status",
      task: state.task ?? this.options.workflow.task,
      status,
      ...(status === "running" ? { resumed: resumed ?? false } : {}),
    });
  }

}

/** MCP must be able to finish a worker turn even when browser IPC or SSE
 * remains pending. A fresh worker still needs a durable conversation identity;
 * accepting an unscoped/standalone conversation is never allowed. */
export async function awaitWorkerReportOrBrowser(options: {
  browser: Promise<WorkerOutput>;
  registry: DevosToolRegistry;
  task: TaskRef;
  active: WorkerReportTurn;
  getSession: () => string | undefined;
  sessionSaved: Promise<void>;
  reportTimeoutMs?: number;
}): Promise<WorkerOutput> {
  const stop = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>(resolve => {
    timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }),
      options.reportTimeoutMs ?? 60 * 60_000);
  });
  const browser = options.browser.then(
    output => ({ kind: "browser" as const, output }),
    error => ({ kind: "browser_error" as const, error }),
  );
  const reported = options.registry.waitForReport(options.task, options.active, stop.signal)
    .then(status => ({ kind: "mcp" as const, status }));
  try {
    // A browser response is not a worker status. In particular, a stray
    // DEVOS_RESULT string cannot bypass the authenticated MCP control plane.
    let winner = await Promise.race([browser, reported, timeout]);
    if (winner.kind === "browser") winner = await Promise.race([reported, timeout]);
    if (winner.kind === "timeout")
      throw new Error("Required devos_worker_report not received before worker deadline; refusing status guess and prompt replay");
    if (winner.kind === "browser_error") {
      // The browser may fail in the small interval between tool publication
      // and observer wakeup; a validated report with a durable session wins.
      const status = await options.registry.readReport(options.task, options.active);
      const session = options.getSession();
      if (status && session) return { text: "", sessionId: session };
      throw winner.error;
    }
    let session = options.getSession();
    if (!session) {
      // A tool report proves the model acted, but cannot prove conversation
      // Project membership by itself. Bound the wait for browser session save.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          options.sessionSaved.then(() => ({ kind: "saved" as const })),
          browser,
          new Promise<{ kind: "timeout" }>(resolve => {
            timer = setTimeout(() => resolve({ kind: "timeout" }), 3 * 60_000);
          }),
        ]);
        if (next.kind === "browser_error") throw next.error;
        if (next.kind === "browser" && next.output.sessionId) return next.output;
        session = options.getSession();
        if (!session) throw new Error("MCP report received without a saved, validated ChatGPT conversation");
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return { text: "", sessionId: session };
  } finally {
    stop.abort();
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function buildWorkerPrompt(
  workflow: Workflow, worker: WorkerSpec, projectRoot?: string,
  report?: { turn: number; token: string },
): string {
  const refs = [
    `${workflow.task.repo} Issue #${workflow.task.issue}`,
    workflow.task.pr ? `PR #${workflow.task.pr}` : null,
  ].filter(Boolean).join(", ");

  return [
    worker.prompt.trim(),
    ...(worker.executor === "codex" && projectRoot ? [
      `Task workspace: ${JSON.stringify(projectRoot)} (the directory containing the project-local devos launcher).`,
      "Perform task work in this exact workspace, including resumed turns. Do not create another clone or worktree, or use runtime or cache directories as the task workspace. A task branch in this workspace is allowed. This workspace instruction takes precedence over generic isolation/worktree skill guidance.",
    ] : []),
    "",
    `Shared task context is in GitHub: ${refs}.`,
    "Read the Issue and, when present, the linked PR, diff, commits, latest worker reports, and review discussion yourself.",
    "Put your meaningful work report in the appropriate GitHub Issue, PR, review, or comment.",
    "Do not invent new workers, roles, or routing during execution. The complete worker graph was declared before DevOS started.",
    `Begin every GitHub report with exactly: **DevOS worker:** \`${worker.id}\` (\`${worker.executor}\`)`,
    worker.executor === "codex"
      ? "This worker already runs on the local Codex executor. It must not return needs_local_worker; return failed for an unrecoverable local-executor failure."
      : "If the task truly requires capabilities unavailable in your environment after you attempted it, return needs_local_worker instead of failed.",
    ...(worker.executor === "chatgpt_browser" && report ? [
      "This is a DevOS-owned browser worker conversation. Before the FIRST operational Desktop Commander or first-party DevOS MCP call in this turn, call the safe devos_worker_probe tool exactly once, with no arguments. This does not itself authorize any operation; the trusted local browser owner verifies its provider-structured tool response in this exact worker chat.",
      "Then check devos_noop for approved=true before using operational Mac/DevOS tools. A brief delay in local proof verification is possible; at most two bounded retries, no rapid polling. If unavailable/unapproved, do not operate the Mac; report the blocker accurately.",
      "Do not request owner passwords, use devos_authorize_chat, supply your chat URL as proof, or reuse devos_worker_report turn tokens for authorization.",
    ] : []),
    ...(report ? [
      "The devos_worker_report MCP tool is the PRIMARY terminal status signal. Perform ALL required work and GitHub reporting BEFORE you call it. Call it once only when this worker's task is fully finished.",
      `Its arguments: repo=${JSON.stringify(workflow.task.repo)}, issue=${workflow.task.issue}, worker_id=${JSON.stringify(worker.id)}, turn=${report.turn}, turn_token=${report.token}; provide status and a short summary.`,
      "Do not write the turn token in GitHub comments or your final answer. The report finalizes this worker turn for DevOS routing, but does not approve the overall task; main-agent review is still mandatory.",
      "The MCP report is REQUIRED and is the only terminal signal DevOS accepts for this browser worker. If the tool is unavailable, do not invent completion or attempt a textual fallback; explain the issue without falsely claiming success. You may send a short final text after the tool call, but DevOS does not parse it.",
    ] : [
      'End your final response with exactly one line: DEVOS_RESULT {"status":"done|approved|changes_requested|needs_local_worker|failed"}',
    ]),
  ].join("\n");
}
