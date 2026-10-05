import type { Executor } from "./executor.js";
import { parseDevosResult } from "./result.js";
import type { Workflow, WorkerSpec } from "./workflow.js";

export interface RunState {
  currentWorkerId: string;
  completedRuns: number;
}

export interface StateStore {
  load(): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
}

export interface OrchestratorOptions {
  projectRoot: string;
  workflow: Workflow;
  executors: Map<string, Executor>;
  stateStore: StateStore;
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
      };

    while (true) {
      const worker = workers.get(state.currentWorkerId);
      if (!worker) throw new Error(`Unknown worker: ${state.currentWorkerId}`);

      const executor = this.options.executors.get(worker.executor);
      if (!executor) throw new Error(`Missing executor: ${worker.executor}`);

      const output = await executor.run({
        projectRoot: this.options.projectRoot,
        prompt: buildWorkerPrompt(workflow, worker),
      });

      const result = parseDevosResult(output.text);
      state = { ...state, completedRuns: state.completedRuns + 1 };

      if (result.status === "failed") {
        await stateStore.save(state);
        throw new Error(`Worker failed: ${worker.id}`);
      }

      const nextWorkerId = result.next ?? worker.on[result.status];

      if (nextWorkerId === null || nextWorkerId === undefined) {
        await stateStore.save(state);
        return state;
      }

      if (!workers.has(nextWorkerId)) {
        throw new Error(`Worker ${worker.id} routed to unknown worker: ${nextWorkerId}`);
      }

      state = { currentWorkerId: nextWorkerId, completedRuns: state.completedRuns };
      await stateStore.save(state);
    }
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
    'End your final response with exactly one line: DEVOS_RESULT {"status":"done|approved|changes_requested|failed","next":"optional-worker-id"}',
  ].join("\n");
}
