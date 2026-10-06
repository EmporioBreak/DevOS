import assert from "node:assert/strict";
import test from "node:test";
import { CodexResumeUnavailableError } from "../src/codex-executor.js";
import { BrowserResumeUnavailableError } from "../src/chatgpt-browser-executor.js";
import type { Executor, WorkerRequest } from "../src/executor.js";
import { Orchestrator, type OrchestrationEvent, type RunState, type StateStore } from "../src/orchestrator.js";
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
  assert.equal(chat.requests[0]?.enforceProjectScope, true);
  assert.equal(chat.requests[1]?.enforceProjectScope, true);
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


test("routes needs_local_worker from ChatGPT to local Codex mechanically", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 99 },
    start: "primary",
    workers: [
      {
        id: "primary",
        executor: "chatgpt_browser",
        prompt: "Attempt the task.",
        on: { done: null, needs_local_worker: "host" },
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
    { text: 'DEVOS_RESULT {"status":"needs_local_worker"}', sessionId: "https://chatgpt.com/c/primary" },
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
    browserWorkersStarted: ["worker"],
    task: { repo: "owner/product", issue: 102 },
  });
});


for (const status of ["needs_local_worker", "changes_requested"] as const) {
  test(`preserves state and rejects unroutable ${status}`, async () => {
    const workflow: Workflow = {
      version: 1,
      task: { repo: "owner/product", issue: 103 },
      start: "worker",
      workers: [
        {
          id: "worker",
          executor: "chatgpt_browser",
          prompt: "Attempt the task.",
          on: {},
        },
      ],
    };

    const store = new MemoryStore();
    const chat = new QueueExecutor("chatgpt_browser", [
      {
        text: `DEVOS_RESULT {"status":"${status}"}`,
        sessionId: "session-3",
      },
    ]);

    await assert.rejects(
      () =>
        new Orchestrator({
          projectRoot: "/project",
          workflow,
          executors: new Map([["chatgpt_browser", chat]]),
          stateStore: store,
        }).run(),
      new RegExp(`unroutable status: ${status}`),
    );

    assert.deepEqual(store.state, {
      currentWorkerId: "worker",
      completedRuns: 1,
      sessions: { worker: "session-3" },
      browserWorkersStarted: ["worker"],
      task: { repo: "owner/product", issue: 103 },
    });
  });
}


test("refuses to silently recreate a previously started browser worker without its saved session", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 104 },
    start: "worker",
    workers: [
      {
        id: "worker",
        executor: "chatgpt_browser",
        prompt: "Resume the task.",
        on: { done: null },
      },
    ],
  };

  const store = new MemoryStore();
  store.state = {
    currentWorkerId: "worker",
    completedRuns: 1,
    sessions: {},
    browserWorkersStarted: ["worker"],
    task: { repo: "owner/product", issue: 104 },
  };
  const chat = new QueueExecutor("chatgpt_browser", []);

  await assert.rejects(
    () =>
      new Orchestrator({
        projectRoot: "/project",
        workflow,
        executors: new Map([["chatgpt_browser", chat]]),
        stateStore: store,
      }).run(),
    /Missing saved browser session for previously started worker: worker/,
  );

  assert.equal(chat.requests.length, 0);
  assert.deepEqual(store.state, {
    currentWorkerId: "worker",
    completedRuns: 1,
    sessions: {},
    browserWorkersStarted: ["worker"],
    task: { repo: "owner/product", issue: 104 },
  });
});

test("marks a browser worker as started before its first executor call", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 105 },
    start: "worker",
    workers: [
      {
        id: "worker",
        executor: "chatgpt_browser",
        prompt: "Start the task.",
        on: { done: null },
      },
    ],
  };

  const store = new MemoryStore();
  const chat: Executor = {
    kind: "chatgpt_browser",
    async run(): Promise<WorkerOutput> {
      assert.deepEqual(store.state?.browserWorkersStarted, ["worker"]);
      throw new Error("simulated browser interruption");
    },
  };

  await assert.rejects(
    () =>
      new Orchestrator({
        projectRoot: "/project",
        workflow,
        executors: new Map([["chatgpt_browser", chat]]),
        stateStore: store,
      }).run(),
    /simulated browser interruption/,
  );

  assert.deepEqual(store.state?.browserWorkersStarted, ["worker"]);
  assert.deepEqual(store.state?.sessions, {});
});


test("persists a returned browser session before parsing malformed worker output", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 106 },
    start: "worker",
    workers: [
      {
        id: "worker",
        executor: "chatgpt_browser",
        prompt: "Continue the task.",
        on: { done: null },
      },
    ],
  };

  const store = new MemoryStore();
  const sessionId =
    "https://chatgpt.com/g/g-p-project/c/conversation-106";
  const chat = new QueueExecutor("chatgpt_browser", [
    { text: "malformed result", sessionId },
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId },
  ]);

  await assert.rejects(
    () =>
      new Orchestrator({
        projectRoot: "/project",
        workflow,
        executors: new Map([["chatgpt_browser", chat]]),
        stateStore: store,
      }).run(),
    /DEVOS_RESULT/,
  );

  assert.deepEqual(store.state, {
    currentWorkerId: "worker",
    completedRuns: 0,
    sessions: { worker: sessionId },
    browserWorkersStarted: ["worker"],
    task: { repo: "owner/product", issue: 106 },
  });

  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", chat]]),
    stateStore: store,
  }).run();

  assert.equal(chat.requests[1]?.sessionId, sessionId);
  assert.equal(result.sessions.worker, sessionId);
  assert.equal(result.completedRuns, 1);
});


test("persists an early browser session when response loading fails after conversation creation", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 107 },
    start: "worker",
    workers: [
      {
        id: "worker",
        executor: "chatgpt_browser",
        prompt: "Continue the task.",
        on: { done: null },
      },
    ],
  };

  const store = new MemoryStore();
  const sessionId =
    "https://chatgpt.com/g/g-p-project/c/conversation-107";
  const interrupted: Executor = {
    kind: "chatgpt_browser",
    async run(request: WorkerRequest): Promise<WorkerOutput> {
      assert.equal(request.sessionId, undefined);
      assert.ok(request.onSession);
      await request.onSession(sessionId);
      throw new Error("simulated response loader failure");
    },
  };

  await assert.rejects(
    () =>
      new Orchestrator({
        projectRoot: "/project",
        workflow,
        executors: new Map([["chatgpt_browser", interrupted]]),
        stateStore: store,
      }).run(),
    /simulated response loader failure/,
  );

  assert.deepEqual(store.state, {
    currentWorkerId: "worker",
    completedRuns: 0,
    sessions: { worker: sessionId },
    browserWorkersStarted: ["worker"],
    task: { repo: "owner/product", issue: 107 },
  });

  const resumed = new QueueExecutor("chatgpt_browser", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId },
  ]);
  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", resumed]]),
    stateStore: store,
  }).run();

  assert.equal(resumed.requests[0]?.sessionId, sessionId);
  assert.equal(result.sessions.worker, sessionId);
  assert.equal(result.completedRuns, 1);
});

test("missing saved browser conversation stops and preserves all identity and PR", async () => {
  const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 108, pr: 50 }, start: "reviewer", workers: [{ id: "reviewer", executor: "chatgpt_browser", prompt: "Review", on: { done: null } }] };
  const store = new MemoryStore();
  const saved = "https://chatgpt.com/g/one/c/missing";
  store.state = { currentWorkerId: "reviewer", completedRuns: 2, sessions: { reviewer: saved, developer: "other" }, browserWorkersStarted: ["reviewer"], task: workflow.task };
  let calls = 0;
  const executor: Executor = { kind: "chatgpt_browser", async run() {
    if (++calls === 1) throw new BrowserResumeUnavailableError(saved, "conversation unavailable");
    return { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "replacement" };
  } };
  await assert.rejects(new Orchestrator({ projectRoot: "/product", workflow, executors: new Map([["chatgpt_browser", executor]]), stateStore: store }).run(), /conversation unavailable/);
  assert.equal(calls, 1);
  assert.deepEqual(store.state?.sessions, { reviewer: saved, developer: "other" });
  assert.deepEqual(store.state?.task, workflow.task);
  assert.equal(store.state?.completedRuns, 2);
});


test("rejects needs_local_worker from an already-local Codex worker", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 146 },
    start: "local",
    workers: [{ id: "local", executor: "codex", prompt: "Work locally.", on: { needs_local_worker: null } }],
  };
  const store = new MemoryStore();
  const codex = new QueueExecutor("codex", [
    { text: 'DEVOS_RESULT {"status":"needs_local_worker"}', sessionId: "thread-local" },
  ]);
  await assert.rejects(
    () => new Orchestrator({
      projectRoot: "/product",
      workflow,
      executors: new Map([["codex", codex]]),
      stateStore: store,
    }).run(),
    /uses codex and cannot return needs_local_worker/,
  );
  assert.equal(store.state?.sessions.local, "thread-local");
  assert.equal(store.state?.sessionProjectRoots?.local, "/product");
});

test("does not resume a Codex session saved for another project root", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 147 },
    start: "local",
    workers: [{ id: "local", executor: "codex", prompt: "Continue.", on: { done: null } }],
  };
  const store = new MemoryStore();
  store.state = {
    currentWorkerId: "local",
    completedRuns: 1,
    sessions: { local: "old-thread" },
    sessionProjectRoots: { local: "/wrong-root" },
    task: workflow.task,
  };
  const codex = new QueueExecutor("codex", [
    { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "new-thread" },
  ]);
  const events: OrchestrationEvent[] = [];
  const result = await new Orchestrator({
    projectRoot: "/product",
    workflow,
    executors: new Map([["codex", codex]]),
    stateStore: store,
    onEvent: event => { events.push(event); },
  }).run();
  assert.equal(codex.requests[0]?.sessionId, undefined);
  assert.equal(codex.requests[0]?.projectRoot, "/product");
  assert.equal(result.sessions.local, "new-thread");
  assert.equal(result.sessionProjectRoots?.local, "/product");
  assert.ok(events.some(event => event.type === "worker_session_recovered" && event.reason.includes("different project root")));
});

test("recovers only the current Codex worker when resume fails", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 148 },
    start: "local",
    workers: [{ id: "local", executor: "codex", prompt: "Continue.", on: { done: null } }],
  };
  const store = new MemoryStore();
  store.state = {
    currentWorkerId: "local",
    completedRuns: 2,
    sessions: { local: "broken-thread", reviewer: "browser-session" },
    sessionProjectRoots: { local: "/product" },
    task: workflow.task,
  };
  const requests: WorkerRequest[] = [];
  let call = 0;
  const codex: Executor = {
    kind: "codex",
    async run(request) {
      requests.push(request);
      if (call++ === 0) throw new CodexResumeUnavailableError("broken-thread", "resume thread not found");
      return { text: 'DEVOS_RESULT {"status":"done"}', sessionId: "replacement-thread" };
    },
  };
  const result = await new Orchestrator({
    projectRoot: "/product",
    workflow,
    executors: new Map([["codex", codex]]),
    stateStore: store,
  }).run();
  assert.equal(requests[0]?.sessionId, "broken-thread");
  assert.equal(requests[1]?.sessionId, undefined);
  assert.equal(result.sessions.local, "replacement-thread");
  assert.equal(result.sessions.reviewer, "browser-session");
});


test("does not replay a resumed Codex worker after a post-execution error", async () => {
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 149 },
    start: "local",
    workers: [{ id: "local", executor: "codex", prompt: "Continue.", on: { done: null } }],
  };
  const store = new MemoryStore();
  store.state = {
    currentWorkerId: "local",
    completedRuns: 2,
    sessions: { local: "existing-thread", reviewer: "browser-session" },
    sessionProjectRoots: { local: "/product" },
    task: workflow.task,
  };
  const requests: WorkerRequest[] = [];
  const codex: Executor = {
    kind: "codex",
    async run(request) {
      requests.push(request);
      throw new Error("Codex did not emit a final agent message");
    },
  };

  await assert.rejects(
    () => new Orchestrator({
      projectRoot: "/product",
      workflow,
      executors: new Map([["codex", codex]]),
      stateStore: store,
    }).run(),
    /did not emit a final agent message/,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.sessionId, "existing-thread");
  assert.equal(store.state?.sessions.local, "existing-thread");
  assert.equal(store.state?.sessions.reviewer, "browser-session");
  assert.equal(store.state?.currentWorkerId, "local");
});

for (const earlyFailure of [false, true]) {
  test(`Codex identity survives ${earlyFailure ? 'post-start failure' : 'malformed final result'} and resumes`, async () => {
    const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 159 }, start: "local", workers: [{ id: "local", executor: "codex", prompt: "Work", on: { done: null } }] };
    const store = new MemoryStore();
    const requests: WorkerRequest[] = [];
    let call = 0;
    const codex: Executor = { kind: "codex", async run(request) {
      requests.push(request);
      if (call++ === 0) {
        if (earlyFailure) { await request.onSession?.("real-thread"); throw new Error("post-start failure"); }
        return { sessionId: "real-thread", text: "missing marker" };
      }
      return { sessionId: "real-thread", text: 'DEVOS_RESULT {"status":"done"}' };
    } };
    const options = { projectRoot: "/product", workflow, executors: new Map([["codex", codex]]), stateStore: store };
    await assert.rejects(new Orchestrator(options).run(), earlyFailure ? /post-start/ : /DEVOS_RESULT/);
    assert.equal(store.state?.sessions.local, "real-thread");
    assert.equal(store.state?.sessionProjectRoots?.local, "/product");
    await new Orchestrator(options).run();
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.sessionId, "real-thread");
  });
}

for (const explicitPr of [undefined, 61]) {
  test(`resume PR precedence with workflow PR ${explicitPr}`, async () => {
    const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 159, ...(explicitPr ? { pr: explicitPr } : {}) }, owner: { mode: "main_agent" }, start: "worker", workers: [{ id: "worker", executor: "chatgpt_browser", prompt: "Work", on: { done: null } }] };
    const store = new MemoryStore();
    store.state = { currentWorkerId: "worker", completedRuns: 1, sessions: { worker: "saved" }, task: { repo: "owner/product", issue: 159, pr: 60 } };
    const chat = new QueueExecutor("chatgpt_browser", [{ sessionId: "saved", text: 'DEVOS_RESULT {"status":"done"}' }]);
    const result = await new Orchestrator({ projectRoot: "/product", workflow, executors: new Map([["chatgpt_browser", chat]]), stateStore: store }).run();
    assert.equal(result.task?.pr, explicitPr ?? 60);
    assert.equal(chat.requests[0]?.sessionId, "saved");
    assert.match(chat.requests[0]!.prompt, new RegExp(`PR #${explicitPr ?? 60}`));
  });
}

test("explicit PR is persisted before a resumed final-review handoff", async () => {
  const store = new MemoryStore();
  store.state = { currentWorkerId: "reviewer", completedRuns: 2, sessions: { reviewer: "saved" }, task: { repo: "owner/product", issue: 159 }, mainAgentReviewPending: true };
  const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 159, pr: 61 }, owner: { mode: "main_agent" }, start: "reviewer", workers: [{ id: "reviewer", executor: "chatgpt_browser", prompt: "Review", on: { approved: null } }] };
  const result = await new Orchestrator({ projectRoot: "/product", workflow, executors: new Map(), stateStore: store }).run();
  assert.equal(result.task?.pr, 61);
  assert.equal(store.state?.task?.pr, 61);
  assert.equal(result.sessions.reviewer, "saved");
});

test("changes_requested cannot override approval waiting only for bookkeeping", async () => {
  const store = new MemoryStore();
  store.state = { currentWorkerId: "reviewer", completedRuns: 2, sessions: { reviewer: "saved" }, completionApproved: true };
  const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 159 }, owner: { mode: "main_agent" }, start: "reviewer", workers: [{ id: "reviewer", executor: "codex", prompt: "Review", on: { approved: null } }] };
  await assert.rejects(new Orchestrator({ projectRoot: "/product", workflow, executors: new Map(), stateStore: store, mainAgentDecision: "changes_requested" }).run(), /waiting for final review/);
  assert.equal(store.state?.completionApproved, true);
});

for (const resumed of [false, true]) {
  test(`local worker receives explicit workspace contract on ${resumed ? "resume" : "fresh"}`, async () => {
    const root = "/projects/My Project";
    const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 62 }, start: "local", workers: [{ id: "local", executor: "codex", prompt: "Work", on: { done: null } }] };
    const store = new MemoryStore();
    if (resumed) store.state = { currentWorkerId: "local", completedRuns: 0, sessions: { local: "thread" }, sessionProjectRoots: { local: root }, task: workflow.task };
    const executor = new QueueExecutor("codex", [{ text: 'DEVOS_RESULT {"status":"done"}', sessionId: "thread" }]);
    await new Orchestrator({ projectRoot: root, workflow, executors: new Map([["codex", executor]]), stateStore: store }).run();
    assert.equal(executor.requests[0]?.projectRoot, root);
    assert.equal(executor.requests[0]?.sessionId, resumed ? "thread" : undefined);
    assert.match(executor.requests[0]!.prompt, /Task workspace: "\/projects\/My Project"/);
    assert.match(executor.requests[0]!.prompt, /Do not create another clone or worktree/);
    assert.match(executor.requests[0]!.prompt, /runtime or cache/);
  });
}

test("legacy browser recovery marker cannot silently replace a missing saved conversation", async () => {
  const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 62, pr: 63 }, start: "browser", workers: [{ id: "browser", executor: "chatgpt_browser", prompt: "Work", on: { done: null } }] };
  const store = new MemoryStore();
  store.state = { currentWorkerId: "browser", completedRuns: 2, sessions: { other: "saved-other" }, browserWorkersStarted: ["browser"], browserSessionRecovery: ["browser"], task: workflow.task };
  const executor = new QueueExecutor("chatgpt_browser", [{ text: 'DEVOS_RESULT {"status":"done"}', sessionId: "replacement" }]);
  await assert.rejects(new Orchestrator({ projectRoot: "/project", workflow, executors: new Map([["chatgpt_browser", executor]]), stateStore: store }).run(), /Missing saved browser session/);
  assert.equal(executor.requests.length, 0);
  assert.deepEqual(store.state?.sessions, { other: "saved-other" });
  assert.deepEqual(store.state?.task, workflow.task);
});
