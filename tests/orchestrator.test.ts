import assert from "node:assert/strict";
import test from "node:test";
import type { Executor, WorkerRequest } from "../src/executor.js";
import { Orchestrator, type RunState, type StateStore } from "../src/orchestrator.js";
import type { ExecutorKind, WorkerOutput, Workflow } from "../src/workflow.js";

class MemoryStore implements StateStore {
  state: RunState | null = null;
  async load(): Promise<RunState | null> { return this.state; }
  async save(state: RunState): Promise<void> { this.state = state; }
}

class QueueExecutor implements Executor {
  constructor(
    readonly kind: ExecutorKind,
    private readonly outputs: WorkerOutput[],
    readonly prompts: string[] = [],
  ) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    this.prompts.push(request.prompt);
    const output = this.outputs.shift();
    if (!output) throw new Error("No queued output");
    return output;
  }
}

test("routes review changes back to developer then finishes on approval", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", pr: 34 },
    start: "developer",
    workers: [
      {
        id: "developer",
        executor: "codex",
        prompt: "Implement the task.",
        on: { done: "reviewer" },
      },
      {
        id: "reviewer",
        executor: "chatgpt_browser",
        prompt: "Review the implementation.",
        on: { changes_requested: "developer", approved: null },
      },
    ],
  };

  const codex = new QueueExecutor("codex", [
    { text: 'DEVOS_RESULT {"status":"done"}' },
    { text: 'DEVOS_RESULT {"status":"done"}' },
  ]);
  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"changes_requested"}' },
    { text: 'DEVOS_RESULT {"status":"approved"}' },
  ]);
  const store = new MemoryStore();

  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([
      ["codex", codex],
      ["chatgpt_browser", chat],
    ]),
    stateStore: store,
  }).run();

  assert.equal(result.completedRuns, 4);
  assert.match(chat.prompts[0] ?? "", /owner\/product PR #34/);
  assert.doesNotMatch(chat.prompts[0] ?? "", /issue #/i);
});
