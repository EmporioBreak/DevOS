import assert from "node:assert/strict";
import test from "node:test";
import type { Executor, WorkerRequest } from "../src/executor.js";
import {
  Orchestrator,
  buildOwnerPrompt,
  type RunState,
  type StateStore,
} from "../src/orchestrator.js";
import type { ExecutorKind, WorkerOutput, Workflow } from "../src/workflow.js";

class MemoryStore implements StateStore {
  state: RunState | null = null;
  async load(): Promise<RunState | null> { return this.state; }
  async save(state: RunState): Promise<void> { this.state = state; }
  async clear(): Promise<void> { this.state = null; }
}

class QueueExecutor implements Executor {
  constructor(
    readonly kind: ExecutorKind,
    private readonly outputs: WorkerOutput[],
    readonly requests: WorkerRequest[] = [],
  ) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    this.requests.push(request);
    const output = this.outputs.shift();
    if (!output) throw new Error("No queued output");
    return output;
  }
}

test("owner changes_requested continues the same task with the same worker sessions", async () => {
  const ownerUrl = "https://chatgpt.com/c/main-owner";
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 39, pr: 40 },
    owner: { mode: "chatgpt_conversation", conversationUrl: ownerUrl },
    start: "developer",
    workers: [
      {
        id: "developer",
        executor: "chatgpt_browser",
        prompt: "Implement.",
        on: { done: "reviewer" },
      },
      {
        id: "reviewer",
        executor: "chatgpt_browser",
        prompt: "Review.",
        on: { approved: null, changes_requested: "developer" },
      },
    ],
  };

  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "https://chatgpt.com/c/dev" },
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: "https://chatgpt.com/c/review" },
    { text: 'DEVOS_RESULT {"status":"changes_requested"}', sessionId: ownerUrl },
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "https://chatgpt.com/c/dev" },
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: "https://chatgpt.com/c/review" },
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: ownerUrl },
  ]);

  const store = new MemoryStore();
  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: store,
  }).run();

  assert.equal(result.completedRuns, 4);
  assert.deepEqual(result.sessions, {
    developer: "https://chatgpt.com/c/dev",
    reviewer: "https://chatgpt.com/c/review",
  });
  assert.equal(chat.requests[2]?.sessionId, ownerUrl);
  assert.equal(chat.requests[3]?.sessionId, "https://chatgpt.com/c/dev");
  assert.equal(chat.requests[4]?.sessionId, "https://chatgpt.com/c/review");
  assert.equal(chat.requests[5]?.sessionId, ownerUrl);
  assert.equal(store.state, null);
});

test("a fresh task starts with no worker session from another task", async () => {
  const workflow = (issue: number): Workflow => ({
    version: 1,
    task: { repo: "owner/product", issue },
    start: "developer",
    workers: [
      {
        id: "developer",
        executor: "chatgpt_browser",
        prompt: "Implement.",
        on: { done: null },
      },
    ],
  });

  const first = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "https://chatgpt.com/c/task-39" },
  ]);
  const second = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "https://chatgpt.com/c/task-40" },
  ]);

  await new Orchestrator({
    projectRoot: "/project",
    workflow: workflow(39),
    executors: new Map([["chatgpt_browser", first]]),
    stateStore: new MemoryStore(),
  }).run();

  await new Orchestrator({
    projectRoot: "/project",
    workflow: workflow(40),
    executors: new Map([["chatgpt_browser", second]]),
    stateStore: new MemoryStore(),
  }).run();

  assert.equal(first.requests[0]?.sessionId, undefined);
  assert.equal(second.requests[0]?.sessionId, undefined);
});

test("parent_process owner preserves task state and requests final review", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 39, pr: 41 },
    owner: { mode: "parent_process" },
    start: "reviewer",
    workers: [
      {
        id: "reviewer",
        executor: "chatgpt_browser",
        prompt: "Review.",
        on: { approved: null },
      },
    ],
  };

  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: "https://chatgpt.com/c/review" },
  ]);
  const store = new MemoryStore();
  const orchestrator = new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: store,
  });

  const result = await orchestrator.run();
  assert.equal(result.ownerReviewPending, true);
  assert.equal(result.sessions.reviewer, "https://chatgpt.com/c/review");
  assert.deepEqual(store.state, result);

  const resumed = await orchestrator.run();
  assert.equal(resumed.ownerReviewPending, true);
  assert.equal(chat.requests.length, 1);
});

test("owner handoff prompt includes the concrete Issue and PR", () => {
  const prompt = buildOwnerPrompt({
    version: 1,
    task: { repo: "owner/product", issue: 39, pr: 41 },
    start: "reviewer",
    workers: [
      {
        id: "reviewer",
        executor: "chatgpt_browser",
        prompt: "Review.",
        on: { approved: null },
      },
    ],
  });

  assert.match(prompt, /https:\/\/github\.com\/owner\/product\/issues\/39/);
  assert.match(prompt, /https:\/\/github\.com\/owner\/product\/pull\/41/);
});
