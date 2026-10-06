import assert from "node:assert/strict";
import test from "node:test";
import type { Executor, WorkerRequest } from "../src/executor.js";
import { formatOrchestrationEvent } from "../src/cli.js";
import {
  Orchestrator,
  type OrchestrationEvent,
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

test("emits worker result before routing and marks browser session re-entry", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 41 },
    owner: { mode: "parent_process" },
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
        on: { changes_requested: "developer", approved: null },
      },
    ],
  };
  const chat = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "dev-session" },
    { text: 'DEVOS_RESULT {"status":"changes_requested"}', sessionId: "review-session" },
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "dev-session" },
    { text: 'DEVOS_RESULT {"status":"approved"}', sessionId: "review-session" },
  ]);
  const events: OrchestrationEvent[] = [];

  await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: new MemoryStore(),
    onEvent: event => { events.push(event); },
  }).run();

  assert.deepEqual(events, [
    { type: "task_started", task: { repo: "owner/product", issue: 41 }, resumed: false },
    { type: "worker_started", workerId: "developer", executor: "chatgpt_browser", session: "fresh" },
    { type: "worker_result", workerId: "developer", executor: "chatgpt_browser", status: "done" },
    { type: "transition", from: "developer", to: "reviewer" },
    { type: "worker_started", workerId: "reviewer", executor: "chatgpt_browser", session: "fresh" },
    { type: "worker_result", workerId: "reviewer", executor: "chatgpt_browser", status: "changes_requested" },
    { type: "transition", from: "reviewer", to: "developer" },
    { type: "worker_started", workerId: "developer", executor: "chatgpt_browser", session: "resumed" },
    { type: "worker_result", workerId: "developer", executor: "chatgpt_browser", status: "done" },
    { type: "transition", from: "developer", to: "reviewer" },
    { type: "worker_started", workerId: "reviewer", executor: "chatgpt_browser", session: "resumed" },
    { type: "worker_result", workerId: "reviewer", executor: "chatgpt_browser", status: "approved" },
    { type: "owner_handoff", task: { repo: "owner/product", issue: 41 } },
  ]);
});

test("makes needs_host to local Codex routing explicit", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 41 },
    start: "reviewer",
    workers: [
      {
        id: "reviewer",
        executor: "chatgpt_browser",
        prompt: "Review.",
        on: { needs_host: "local_reviewer" },
      },
      {
        id: "local_reviewer",
        executor: "codex",
        prompt: "Review locally.",
        on: { approved: null },
      },
    ],
  };
  const events: OrchestrationEvent[] = [];

  await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([
      ["chatgpt_browser", new QueueExecutor("chatgpt_browser", [
        { text: 'DEVOS_RESULT {"status":"needs_host"}', sessionId: "review-session" },
      ])],
      ["codex", new QueueExecutor("codex", [
        { text: 'DEVOS_RESULT {"status":"approved"}' },
      ])],
    ]),
    stateStore: new MemoryStore(),
    onEvent: event => { events.push(event); },
  }).run();

  const needsHost = events.findIndex(
    event => event.type === "worker_result" && event.status === "needs_host",
  );
  const transition = events.findIndex(
    event => event.type === "transition" && event.to === "local_reviewer",
  );
  const localStart = events.findIndex(
    event => event.type === "worker_started" && event.workerId === "local_reviewer",
  );
  assert.ok(needsHost >= 0 && transition > needsHost && localStart > transition);
});

test("failed status is emitted before the orchestrator rejects", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 41 },
    start: "developer",
    workers: [
      {
        id: "developer",
        executor: "chatgpt_browser",
        prompt: "Implement.",
        on: { failed: null },
      },
    ],
  };
  const events: OrchestrationEvent[] = [];

  await assert.rejects(
    () => new Orchestrator({
      projectRoot: "/project",
      workflow,
      executors: new Map([["chatgpt_browser", new QueueExecutor("chatgpt_browser", [
        { text: 'DEVOS_RESULT {"status":"failed"}', sessionId: "dev-session" },
      ])]]),
      stateStore: new MemoryStore(),
      onEvent: event => { events.push(event); },
    }).run(),
    /Worker failed: developer/,
  );

  assert.deepEqual(events.at(-1), {
    type: "worker_result",
    workerId: "developer",
    executor: "chatgpt_browser",
    status: "failed",
  });
});

test("CLI renders concise lifecycle lines without exposing session ids", () => {
  assert.equal(
    formatOrchestrationEvent({
      type: "worker_started",
      workerId: "developer",
      executor: "chatgpt_browser",
      session: "resumed",
    }),
    "[developer] chatgpt_browser — resuming existing session\n",
  );
  assert.equal(
    formatOrchestrationEvent({
      type: "worker_result",
      workerId: "reviewer",
      executor: "chatgpt_browser",
      status: "needs_host",
    }),
    "[reviewer] chatgpt_browser — needs_host\n",
  );
  assert.equal(
    formatOrchestrationEvent({ type: "transition", from: "reviewer", to: "local_reviewer" }),
    "→ local_reviewer\n",
  );
});

test("marks a persisted task run as resumed", async () => {
  const store = new MemoryStore();
  store.state = {
    currentWorkerId: "developer",
    completedRuns: 2,
    sessions: { developer: "dev-session" },
    task: { repo: "owner/product", issue: 41 },
  };
  const events: OrchestrationEvent[] = [];

  await new Orchestrator({
    projectRoot: "/project",
    workflow: {
      version: 1,
      task: { repo: "owner/product", issue: 41 },
      start: "developer",
      workers: [{
        id: "developer",
        executor: "chatgpt_browser",
        prompt: "Continue.",
        on: { done: null },
      }],
    },
    executors: new Map([["chatgpt_browser", new QueueExecutor("chatgpt_browser", [
      { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "dev-session" },
    ])]]),
    stateStore: store,
    onEvent: event => { events.push(event); },
  }).run();

  assert.deepEqual(events[0], {
    type: "task_started",
    task: { repo: "owner/product", issue: 41 },
    resumed: true,
  });
  assert.deepEqual(events[1], {
    type: "worker_started",
    workerId: "developer",
    executor: "chatgpt_browser",
    session: "resumed",
  });
});
