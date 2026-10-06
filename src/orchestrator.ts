import { isCodexResumeUnavailableError } from "./codex-executor.js";
import type { Executor } from "./executor.js";
import { parseDevosResult } from "./result.js";
import type { ExecutorKind, TaskRef, WorkerOutput, WorkerStatus, Workflow, WorkerSpec } from "./workflow.js";

export interface RunState {
  currentWorkerId: string;
  completedRuns: number;
  sessions: Record<string, string>;
  sessionProjectRoots?: Record<string, string>;
  browserWorkersStarted?: string[];
  browserSessionRecovery?: string[];
  task?: TaskRef;
  mainAgentReviewPending?: boolean;
  completionApproved?: boolean;
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
      };

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
        sessions: state.sessions,
        ...(state.sessionProjectRoots ? { sessionProjectRoots: state.sessionProjectRoots } : {}),
        ...(state.browserWorkersStarted
          ? { browserWorkersStarted: state.browserWorkersStarted }
          : {}),
        ...(state.browserSessionRecovery
          ? { browserSessionRecovery: state.browserSessionRecovery }
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
      const worker = workers.get(state.currentWorkerId);
      if (!worker) throw new Error(`Unknown worker: ${state.currentWorkerId}`);

      const executor = this.options.executors.get(worker.executor);
      if (!executor) throw new Error(`Missing executor: ${worker.executor}`);

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
      if (browserWorkerAlreadyStarted && !sessionId) {
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

      await this.emit({
        type: "worker_started",
        workerId: worker.id,
        executor: worker.executor,
        session: sessionId ? "resumed" : "fresh",
      });
      const activeWorkflow = { ...workflow, task: state.task ?? workflow.task };
      const onSession = async (reportedSessionId: string) => {
        state = {
          ...state,
          sessions: { ...state.sessions, [worker.id]: reportedSessionId },
          ...(worker.executor === "codex" ? { sessionProjectRoots: { ...(state.sessionProjectRoots ?? {}), [worker.id]: this.options.projectRoot } } : {}),
          ...(state.browserSessionRecovery ? { browserSessionRecovery: state.browserSessionRecovery.filter(id => id !== worker.id) } : {}),
        };
        await stateStore.save(state);
      };
      let output: WorkerOutput;
      try {
        output = await executor.run({
          projectRoot: this.options.projectRoot,
          prompt: buildWorkerPrompt(activeWorkflow, worker, this.options.projectRoot),
          ...(sessionId ? { sessionId } : {}),
          ...(worker.executor === "chatgpt_browser" ? { enforceProjectScope: true } : {}),
          onSession,
        });
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
        } else {
          throw error;
        }
      }

      if (output.sessionId !== undefined) await onSession(output.sessionId);
      const sessions = state.sessions;
      const sessionProjectRoots = state.sessionProjectRoots;
      const result = parseDevosResult(output.text);
      if (worker.executor === "codex" && result.status === "needs_local_worker") {
        state = { ...state, sessions, ...(sessionProjectRoots ? { sessionProjectRoots } : {}) };
        await stateStore.save(state);
        await this.emitTaskStatus(state, "failed");
        throw new Error(
          `Worker ${worker.id} uses codex and cannot return needs_local_worker`,
        );
      }
      state = {
        ...state,
        sessions,
        ...(sessionProjectRoots ? { sessionProjectRoots } : {}),
        completedRuns: state.completedRuns + 1,
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
          sessions: state.sessions,
          ...(state.sessionProjectRoots ? { sessionProjectRoots: state.sessionProjectRoots } : {}),
          ...(state.browserWorkersStarted
            ? { browserWorkersStarted: state.browserWorkersStarted }
            : {}),
          ...(state.browserSessionRecovery
            ? { browserSessionRecovery: state.browserSessionRecovery }
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

export function buildWorkerPrompt(workflow: Workflow, worker: WorkerSpec, projectRoot?: string): string {
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
    'End your final response with exactly one line: DEVOS_RESULT {"status":"done|approved|changes_requested|needs_local_worker|failed"}',
  ].join("\n");
}
