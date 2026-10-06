import type { Executor } from "./executor.js";
import { parseDevosResult } from "./result.js";
import type { ExecutorKind, TaskRef, WorkerStatus, Workflow, WorkerSpec } from "./workflow.js";

export interface RunState {
  currentWorkerId: string;
  completedRuns: number;
  sessions: Record<string, string>;
  browserWorkersStarted?: string[];
  task?: TaskRef;
  ownerReviewPending?: boolean;
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
  | { type: "owner_handoff"; task: TaskRef };

export interface OrchestratorOptions {
  projectRoot: string;
  workflow: Workflow;
  executors: Map<string, Executor>;
  stateStore: StateStore;
  ownerDecision?: "approved" | "changes_requested";
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

    if (!state.task) {
      state = { ...state, task: workflow.task };
    }

    if (state.ownerReviewPending) {
      const decision = this.options.ownerDecision;
      if (!decision) {
        await this.emit({
          type: "owner_handoff",
          task: state.task ?? workflow.task,
        });
        await this.emitTaskStatus(state, "final_review_required");
        return state;
      }

      if (decision === "approved") {
        const completed = {
          currentWorkerId: state.currentWorkerId,
          completedRuns: state.completedRuns,
          sessions: state.sessions,
          ...(state.browserWorkersStarted
            ? { browserWorkersStarted: state.browserWorkersStarted }
            : {}),
          task: state.task ?? workflow.task,
        };
        await this.emitTaskStatus(completed, "completed");
        await stateStore.clear();
        return completed;
      }

      await this.emitTaskStatus(state, "changes_requested");
      state = {
        currentWorkerId: workflow.start,
        completedRuns: state.completedRuns,
        sessions: state.sessions,
        ...(state.browserWorkersStarted
          ? { browserWorkersStarted: state.browserWorkersStarted }
          : {}),
        task: state.task ?? workflow.task,
      };
      await stateStore.save(state);
      await this.emit({ type: "transition", from: "owner", to: workflow.start });
      await this.emitTaskStatus(state, "running", true);
    } else {
      await this.emitTaskStatus(state, "running", persistedState !== null);
    }

    while (true) {
      const worker = workers.get(state.currentWorkerId);
      if (!worker) throw new Error(`Unknown worker: ${state.currentWorkerId}`);

      const executor = this.options.executors.get(worker.executor);
      if (!executor) throw new Error(`Missing executor: ${worker.executor}`);

      const sessionId = state.sessions[worker.id];
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
      const output = await executor.run({
        projectRoot: this.options.projectRoot,
        prompt: buildWorkerPrompt(activeWorkflow, worker),
        ...(sessionId ? { sessionId } : {}),
        ...(worker.executor === "chatgpt_browser" ? { requireProject: true } : {}),
      });

      const sessions =
        output.sessionId === undefined
          ? state.sessions
          : { ...state.sessions, [worker.id]: output.sessionId };

      const result = parseDevosResult(output.text);
      state = {
        ...state,
        sessions,
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
            type: "owner_handoff",
            task: state.task ?? workflow.task,
          });
        }
        const ownerResult = await this.handoffToOwner(state);
        if (ownerResult === "approved") {
          await this.emitTaskStatus(state, "completed");
          await stateStore.clear();
          return state;
        }

        if (ownerResult === "final_review_required") {
          state = { ...state, ownerReviewPending: true };
          await stateStore.save(state);
          await this.emitTaskStatus(state, "final_review_required");
          return state;
        }

        await this.emitTaskStatus(state, "changes_requested");
        state = {
          currentWorkerId: workflow.start,
          completedRuns: state.completedRuns,
          sessions: state.sessions,
          ...(state.browserWorkersStarted
            ? { browserWorkersStarted: state.browserWorkersStarted }
            : {}),
          task: state.task ?? workflow.task,
        };
        await stateStore.save(state);
        await this.emit({ type: "transition", from: "owner", to: workflow.start });
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

  private async handoffToOwner(
    state: RunState,
  ): Promise<"approved" | "changes_requested" | "final_review_required"> {
    const { workflow } = this.options;
    const owner = workflow.owner;
    const activeWorkflow = { ...workflow, task: state.task ?? workflow.task };

    if (!owner) return "approved";
    if (owner.mode === "parent_process") return "final_review_required";

    const executor = this.options.executors.get("chatgpt_browser");
    if (!executor) throw new Error("Missing executor: chatgpt_browser");

    const output = await executor.run({
      projectRoot: this.options.projectRoot,
      prompt: buildOwnerPrompt(activeWorkflow),
      sessionId: owner.conversationUrl,
    });
    const result = parseDevosResult(output.text);

    if (result.status === "approved" || result.status === "changes_requested") {
      return result.status;
    }

    await this.options.stateStore.save(state);
    throw new Error(
      `Task owner returned unsupported final-review status: ${result.status}`,
    );
  }
}

export function buildWorkerPrompt(workflow: Workflow, worker: WorkerSpec): string {
  const refs = [
    `${workflow.task.repo} Issue #${workflow.task.issue}`,
    workflow.task.pr ? `PR #${workflow.task.pr}` : null,
  ].filter(Boolean).join(", ");

  return [
    worker.prompt.trim(),
    "",
    `Shared task context is in GitHub: ${refs}.`,
    "Read the Issue and, when present, the linked PR, diff, commits, latest worker reports, and review discussion yourself.",
    "Put your meaningful work report in the appropriate GitHub Issue, PR, review, or comment.",
    "Do not invent new workers, roles, or routing during execution. The complete worker graph was declared before DevOS started.",
    `Begin every GitHub report with exactly: **DevOS worker:** \`${worker.id}\` (\`${worker.executor}\`)`,
    'If the task truly requires capabilities unavailable in your environment after you attempted it, return needs_local_worker instead of failed.',
    'End your final response with exactly one line: DEVOS_RESULT {"status":"done|approved|changes_requested|needs_local_worker|failed"}',
  ].join("\n");
}

export function buildOwnerPrompt(workflow: Workflow): string {
  const issueUrl = `https://github.com/${workflow.task.repo}/issues/${workflow.task.issue}`;
  const prUrl = workflow.task.pr
    ? `https://github.com/${workflow.task.repo}/pull/${workflow.task.pr}`
    : null;

  return [
    "DevOS worker phase is ready for final task-level review.",
    `Issue: ${issueUrl}`,
    ...(prUrl ? [`PR: ${prUrl}`] : []),
    "Perform final acceptance in this owning conversation.",
    "Return changes_requested if more work is required; otherwise return approved.",
    'End your response with exactly one line: DEVOS_RESULT {"status":"approved|changes_requested"}',
  ].join("\n");
}
