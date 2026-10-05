import assert from "node:assert/strict";
import test from "node:test";
import type { Executor, WorkerRequest } from "../src/executor.js";
import { Orchestrator, type RunState, type StateStore } from "../src/orchestrator.js";
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

test("reuses each worker session across review loops", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 12, pr: 34 },
    start: "developer",
    workers: [
      { id: "developer", executor: "codex", prompt: "Implement.", on: { done: "reviewer" } },
      { id: "reviewer", executor: "chatgpt_browser", prompt: "Review.", on: { changes_requested: "developer", approved: null } },
    ],
  };

  const codex = new QueueExecutor("codex", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "codex-1" },
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "codex-1" },
  ]);
  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"changes_requested"}', sessionId: "https://chatgpt.com/c/review-1" },
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: "https://chatgpt.com/c/review-1" },
  ]);

  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["codex", codex], ["chatgpt_browser", chat]]),
    stateStore: new MemoryStore(),
  }).run();

  assert.equal(result.completedRuns, 4);
  assert.deepEqual(result.sessions, {
    developer: "codex-1",
    reviewer: "https://chatgpt.com/c/review-1",
  });
  assert.equal(codex.requests[1]?.sessionId, "codex-1");
  assert.equal(chat.requests[1]?.sessionId, "https://chatgpt.com/c/review-1");
  assert.match(chat.requests[0]?.prompt ?? "", /Issue #12/);
  assert.match(chat.requests[0]?.prompt ?? "", /PR #34/);
  assert.match(
    chat.requests[0]?.prompt ?? "",
    /\*\*DevOS worker:\*\* `reviewer` \(`chatgpt_browser`\)/,
  );
});

test("starts without a pull request or existing sessions", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 12 },
    start: "developer",
    workers: [
      { id: "developer", executor: "codex", prompt: "Start.", on: { done: null } },
    ],
  };

  const codex = new QueueExecutor("codex", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "codex-1" },
  ]);

  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["codex", codex]]),
    stateStore: new MemoryStore(),
  }).run();

  assert.equal(codex.requests[0]?.sessionId, undefined);
  assert.match(codex.requests[0]?.prompt ?? "", /Issue #12/);
  assert.doesNotMatch(codex.requests[0]?.prompt ?? "", /PR #/);
  assert.deepEqual(result.sessions, { developer: "codex-1" });
});


test("routes needs_host from ChatGPT to local Codex mechanically", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 99 },
    start: "primary",
    workers: [
      {
        id: "primary",
        executor: "chatgpt_browser",
        prompt: "Attempt the task.",
        on: { done: null, needs_host: "host" },
      },
      {
        id: "host",
        executor: "codex",
        prompt: "Continue on the host machine.",
        on: { done: null },
      },
    ],
  };

  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"needs_host"}', sessionId: "https://chatgpt.com/c/primary" },
  ]);
  const codex = new QueueExecutor("codex", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "codex-host" },
  ]);

  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat], ["codex", codex]]),
    stateStore: new MemoryStore(),
  }).run();

  assert.equal(result.completedRuns, 2);
  assert.equal(chat.requests.length, 1);
  assert.equal(codex.requests.length, 1);
});


test("clears persisted state after successful completion", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 101 },
    start: "worker",
    workers: [
      {
        id: "worker",
        executor: "chatgpt_browser",
        prompt: "Complete the task.",
        on: { done: null },
      },
    ],
  };

  const store = new MemoryStore();
  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "session-1" },
  ]);

  await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: store,
  }).run();

  assert.equal(store.state, null);
});

test("keeps persisted state after worker failure", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 102 },
    start: "worker",
    workers: [
      {
        id: "worker",
        executor: "chatgpt_browser",
        prompt: "Attempt the task.",
        on: { failed: null },
      },
    ],
  };

  const store = new MemoryStore();
  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"failed"}', sessionId: "session-2" },
  ]);

  await assert.rejects(
    () =>
      new Orchestrator({
        projectRoot: "/project",
        workflow,
        executors: new Map([["chatgpt_browser", chat]]),
        stateStore: store,
      }).run(),
    /Worker failed/,
  );

  assert.deepEqual(store.state, {
    currentWorkerId: "worker",
    completedRuns: 1,
    sessions: { worker: "session-2" },
  });
});
