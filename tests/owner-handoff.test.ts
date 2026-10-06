import assert from "node:assert/strict";
import test from "node:test";
import type { Executor, WorkerRequest } from "../src/executor.js";
import {
  Orchestrator,
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

test("main_agent changes_requested continues the same task with the same worker sessions", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 39, pr: 40 },
    owner: { mode: "main_agent" },
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
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "https://chatgpt.com/c/dev" },
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
  assert.equal(result.mainAgentReviewPending, true);
  const continued = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: store,
    mainAgentDecision: "changes_requested",
  }).run();

  assert.equal(continued.completedRuns, 4);
  assert.deepEqual(continued.sessions, {
    developer: "https://chatgpt.com/c/dev",
    reviewer: "https://chatgpt.com/c/review",
  });
  assert.equal(chat.requests[2]?.sessionId, "https://chatgpt.com/c/dev");
  assert.equal(chat.requests[3]?.sessionId, "https://chatgpt.com/c/review");
  assert.equal(continued.mainAgentReviewPending, true);
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

test("main_agent owner preserves task state and requests final review", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 39, pr: 41 },
    owner: { mode: "main_agent" },
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
  assert.equal(result.mainAgentReviewPending, true);
  assert.equal(result.sessions.reviewer, "https://chatgpt.com/c/review");
  assert.deepEqual(store.state, result);

  const resumed = await orchestrator.run();
  assert.equal(resumed.mainAgentReviewPending, true);
  assert.equal(chat.requests.length, 1);

  const continuedChat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: "https://chatgpt.com/c/review" },
  ]);
  const continued = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", continuedChat]]),
    stateStore: store,
    mainAgentDecision: "changes_requested",
  }).run();

  assert.equal(continued.mainAgentReviewPending, true);
  assert.equal(continuedChat.requests[0]?.sessionId, "https://chatgpt.com/c/review");
});

test("Issue-only workflow resolves and persists a later PR before main-agent handoff", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 39 },
    owner: { mode: "main_agent" },
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

  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: store,
    resolveTask: async task => ({ ...task, pr: 40 }),
  }).run();

  assert.deepEqual(result.task, { repo: "owner/product", issue: 39, pr: 40 });
  assert.equal(chat.requests.length, 1);
  assert.deepEqual(store.state?.task, { repo: "owner/product", issue: 39, pr: 40 });
});
