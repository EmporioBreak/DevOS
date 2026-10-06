import type { Executor } from "./executor.js";
import { parseDevosResult } from "./result.js";
import type { Workflow, WorkerSpec } from "./workflow.js";

export interface RunState {
  currentWorkerId: string;
  completedRuns: number;
  sessions: Record<string, string>;
  ownerReviewPending?: boolean;
}

export interface StateStore {
  load(): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  clear(): Promise<void>;
}

export interface OrchestratorOptions {
  projectRoot: string;
  workflow: Workflow;
  executors: Map<string, Executor>;
  stateStore: StateStore;
  ownerDecision?: "approved" | "changes_requested";
}

export class Orchestrator {
  constructor(private readonly options: OrchestratorOptions) {}

  async run(): Promise<RunState> {
    const { workflow, stateStore } = this.options;
    const workers = new Map(workflow.workers.map((worker) => [worker.id, worker]));
    let state =
      (await stateStore.load()) ?? {
        currentWorkerId: workflow.start,
        completedRuns: 0,
        sessions: {},
      };

    if (state.ownerReviewPending) {
      const decision = this.options.ownerDecision;
      if (!decision) return state;

      if (decision === "approved") {
        const completed = {
          currentWorkerId: state.currentWorkerId,
          completedRuns: state.completedRuns,
          sessions: state.sessions,
        };
        await stateStore.clear();
        return completed;
      }

      state = {
        currentWorkerId: workflow.start,
        completedRuns: state.completedRuns,
        sessions: state.sessions,
      };
      await stateStore.save(state);
    }

    while (true) {
      const worker = workers.get(state.currentWorkerId);
      if (!worker) throw new Error(`Unknown worker: ${state.currentWorkerId}`);

      const executor = this.options.executors.get(worker.executor);
      if (!executor) throw new Error(`Missing executor: ${worker.executor}`);

      const sessionId = state.sessions[worker.id];
      const output = await executor.run({
        projectRoot: this.options.projectRoot,
        prompt: buildWorkerPrompt(workflow, worker),
        ...(sessionId ? { sessionId } : {}),
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

      if (result.status === "failed") {
        await stateStore.save(state);
        throw new Error(`Worker failed: ${worker.id}`);
      }

      const nextWorkerId = worker.on[result.status];

      if (
        (result.status === "needs_host" || result.status === "changes_requested") &&
        (nextWorkerId === null || nextWorkerId === undefined)
      ) {
        await stateStore.save(state);
        throw new Error(
          `Worker ${worker.id} returned unroutable status: ${result.status}`,
        );
      }

      if (nextWorkerId === null || nextWorkerId === undefined) {
        const ownerResult = await this.handoffToOwner(state);
        if (ownerResult === "approved") {
          await stateStore.clear();
          return state;
        }

        if (ownerResult === "final_review_required") {
          state = { ...state, ownerReviewPending: true };
          await stateStore.save(state);
          return state;
        }

        state = {
          currentWorkerId: workflow.start,
          completedRuns: state.completedRuns,
          sessions: state.sessions,
        };
        await stateStore.save(state);
        continue;
      }

      if (!workers.has(nextWorkerId)) {
        throw new Error(`Worker ${worker.id} routed to unknown worker: ${nextWorkerId}`);
      }

      state = { ...state, currentWorkerId: nextWorkerId };
      await stateStore.save(state);
    }
  }

  private async handoffToOwner(
    state: RunState,
  ): Promise<"approved" | "changes_requested" | "final_review_required"> {
    const { workflow } = this.options;
    const owner = workflow.owner;

    if (!owner) return "approved";
    if (owner.mode === "parent_process") return "final_review_required";

    const executor = this.options.executors.get("chatgpt_browser");
    if (!executor) throw new Error("Missing executor: chatgpt_browser");

    const output = await executor.run({
      projectRoot: this.options.projectRoot,
      prompt: buildOwnerPrompt(workflow),
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
    'If the task truly requires capabilities unavailable in your environment after you attempted it, return needs_host instead of failed.',
    'End your final response with exactly one line: DEVOS_RESULT {"status":"done|approved|changes_requested|needs_host|failed"}',
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
