import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore } from "../src/json-state-store.js";
import { DevosToolRegistry, reportTokenHash } from "../src/mcp-tools/registry.js";
import { Orchestrator } from "../src/orchestrator.js";
import { BrowserResumeUnavailableError } from "../src/chatgpt-browser-executor.js";
import type { Executor, WorkerRequest } from "../src/executor.js";
import type { Workflow, WorkerStatus } from "../src/workflow.js";

const task = { repo: "Example/McpWorker", issue: 101 };
const workflow: Workflow = {
  version: 1, task, owner: { mode: "main_agent" }, start: "reviewer",
  workers: [
    { id: "reviewer", executor: "chatgpt_browser", prompt: "Review.", on: { changes_requested: "developer", approved: null } },
    { id: "developer", executor: "chatgpt_browser", prompt: "Fix.", on: { done: "reviewer" } },
  ],
};
function tokenFor(request: WorkerRequest): string {
  const token = /turn_token=([a-f0-9]{64})/.exec(request.prompt)?.[1];
  assert.ok(token, "orchestrator must issue per-turn token");
  return token;
}
function turnFor(request: WorkerRequest): number {
  const turn = /turn=(\d+), turn_token=/.exec(request.prompt)?.[1];
  assert.ok(turn);
  return Number(turn);
}
async function fixture(fn: (root: string, registry: DevosToolRegistry, store: JsonStateStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-result-"));
  try { await fn(root, new DevosToolRegistry(root), new JsonStateStore(root, task)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function sendReport(registry: DevosToolRegistry, request: WorkerRequest, status: WorkerStatus) {
  const report = await registry.call("devos_worker_report", {
    ...task, worker_id: request.workerId, turn: turnFor(request),
    turn_token: tokenFor(request), status, summary: "Checked the work",
  });
  assert.equal(report.isError, undefined, report.content[0]?.text);
}
test("MCP reports route through the predeclared graph without a textual final marker", async () => {
  await fixture(async (root, registry, store) => {
    const expected: Array<{ worker: string; status: WorkerStatus }> = [
      { worker: "reviewer", status: "changes_requested" },
      { worker: "developer", status: "done" },
      { worker: "reviewer", status: "approved" },
    ];
    const tokens = new Set<string>();
    const sessions: Record<string, string> = {};
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        const next = expected.shift();
        assert.equal(request.workerId, next?.worker);
        tokens.add(tokenFor(request));
        assert.match(request.browserTurnId ?? "", new RegExp("^" + turnFor(request) + ":" + next?.worker + ":[a-f0-9]{64}$"));
        const session = sessions[next!.worker] ??= "https://chatgpt.com/g/project/c/" + next!.worker;
        await request.onSession?.(session);
        await sendReport(registry, request, next!.status);
        return { text: "Work recorded on GitHub, final response complete.", sessionId: session };
      },
    };
    const result = await new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run();
    assert.equal(result.completedRuns, 3);
    assert.equal(result.mainAgentReviewPending, true);
    assert.equal(tokens.size, 3, "each turn gets a unique capability");
    assert.deepEqual(expected, []);
  });
});
test("mismatched final status and MCP report fails closed", async () => {
  await fixture(async (root, registry, store) => {
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        await request.onSession?.("https://chatgpt.com/g/project/c/reviewer");
        await sendReport(registry, request, "approved");
        return { text: 'Completed.\nDEVOS_RESULT {"status":"changes_requested"}' };
      },
    };
    await assert.rejects(new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run(), /conflicting statuses/);
    assert.equal((await store.load())?.completedRuns, 0);
  });
});
test("stale report from earlier run and invalid token cannot route a new run", async () => {
  await fixture(async (root, registry, store) => {
    let firstToken = "";
    const first: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        firstToken = tokenFor(request);
        await sendReport(registry, request, "approved");
        return { text: "A completed response without status marker" };
      },
    };
    const options = {
      projectRoot: root, workflow, stateStore: store, enableWorkerReports: true,
    };
    await new Orchestrator({ ...options, executors: new Map([["chatgpt_browser", first]]) }).run();
    await store.clear();
    const second: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        assert.notEqual(tokenFor(request), firstToken);
        const bad = await registry.call("devos_worker_report", {
          ...task, worker_id: "reviewer", turn: 0, status: "approved",
          summary: "Old status", turn_token: firstToken,
        });
        assert.equal(bad.isError, true);
        return { text: "Another completed response without status marker" };
      },
    };
    await assert.rejects(new Orchestrator({
      ...options, executors: new Map([["chatgpt_browser", second]]),
    }).run(), /DEVOS_RESULT/);
    assert.equal((await store.load())?.completedRuns, 0);
  });
});
test("malformed textual status cannot be overridden by an MCP report", async () => {
  await fixture(async (root, registry, store) => {
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        await sendReport(registry, request, "approved");
        return { text: 'Completed.\nDEVOS_RESULT {"status":"invalid"}' };
      },
    };
    await assert.rejects(new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run(), /invalid status/);
    assert.equal((await store.load())?.completedRuns, 0);
  });
});
test("identical final and MCP statuses remain compatible", async () => {
  await fixture(async (root, registry, store) => {
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        await sendReport(registry, request, "approved");
        return { text: 'Complete.\nDEVOS_RESULT {"status":"approved"}' };
      },
    };
    const result = await new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run();
    assert.equal(result.completedRuns, 1);
    assert.equal(result.mainAgentReviewPending, true);
  });
});
test("misplaced DEVOS_RESULT cannot be hidden by a valid MCP report", async () => {
  await fixture(async (root, registry, store) => {
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        await sendReport(registry, request, "approved");
        return { text: 'DEVOS_RESULT {"status":"changes_requested"}\nTrailing explanation' };
      },
    };
    await assert.rejects(new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run(), /DEVOS_RESULT/);
    assert.equal((await store.load())?.completedRuns, 0);
  });
});

test("the orchestrator routes on terminal MCP while browser worker promise never settles", { timeout: 10_000 }, async () => {
  await fixture(async (root, registry, store) => {
    let called = 0;
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        called++;
        await request.onSession?.("https://chatgpt.com/g/project/c/reviewer");
        await sendReport(registry, request, "approved");
        return await new Promise<never>(() => {});
      },
    };
    const result = await Promise.race([
      new Orchestrator({
        projectRoot: root, workflow, stateStore: store,
        executors: new Map([["chatgpt_browser", executor]]),
        enableWorkerReports: true,
      }).run(),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("Orchestrator incorrectly required browser SSE completion")), 2_000,
      )),
    ]);
    assert.equal(called, 1, "one and only one DOM submission");
    assert.equal(result.completedRuns, 1);
    assert.equal(result.mainAgentReviewPending, true);
    assert.equal(result.activeReport, undefined);
  });
});
test("a crashed browser after a valid terminal MCP report cannot override that status", async () => {
  await fixture(async (root, registry, store) => {
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        await request.onSession?.("https://chatgpt.com/g/project/c/reviewer");
        await sendReport(registry, request, "approved");
        throw new Error("browser process disconnected after report");
      },
    };
    const result = await new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run();
    assert.equal(result.completedRuns, 1);
    assert.equal(result.mainAgentReviewPending, true);
  });
});

test("a committed MCP terminal report survives orchestration crash without resubmitting", async () => {
  await fixture(async (root, registry, store) => {
    const oldToken = "c".repeat(64);
    const active = { workerId: "reviewer", turn: 0, tokenHash: reportTokenHash(oldToken) };
    const session = "https://chatgpt.com/g/project/c/reviewer";
    await store.save({
      currentWorkerId: "reviewer", completedRuns: 0, sessions: { reviewer: session },
      task, activeReport: active, browserWorkersStarted: ["reviewer"],
    });
    const saved = await registry.call("devos_worker_report", {
      ...task, worker_id: "reviewer", turn: 0,
      turn_token: oldToken, status: "approved", summary: "Work complete before crash",
    });
    assert.equal(saved.isError, undefined);
    let calls = 0;
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run() { calls++; throw new Error("Unsafe duplicate submit"); },
    };
    const result = await new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run();
    assert.equal(calls, 0);
    assert.equal(result.completedRuns, 1);
    assert.equal(result.mainAgentReviewPending, true);
    assert.equal(result.activeReport, undefined);
  });
});

test("an unresolved prior browser turn fails closed instead of replaying a prompt", async () => {
  await fixture(async (root, registry, store) => {
    const active = { workerId: "reviewer", turn: 0, tokenHash: reportTokenHash("a".repeat(64)) };
    await store.save({
      currentWorkerId: "reviewer", completedRuns: 0, task, activeReport: active,
      sessions: { reviewer: "https://chatgpt.com/g/project/c/reviewer" },
      browserWorkersStarted: ["reviewer"],
    });
    let calls = 0;
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run() { calls++; throw new Error("Unsafe duplicate submit"); },
    };
    await assert.rejects(new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run(), /Unresolved prior browser turn/);
    assert.equal(calls, 0);
  });
});

test("proven pre-submit failure permits a new tokenized turn on explicit retry", async () => {
  await fixture(async (root, registry, store) => {
    const stale = reportTokenHash("b".repeat(64));
    await store.save({
      currentWorkerId: "reviewer", completedRuns: 0, task,
      activeReport: { workerId: "reviewer", turn: 0, tokenHash: stale },
      sessions: {}, browserWorkersStarted: ["reviewer"],
      browserPreSubmitRetry: ["reviewer"],
    });
    let calls = 0;
    const executor: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        calls++;
        assert.notEqual(reportTokenHash(tokenFor(request)), stale);
        await request.onSession?.("https://chatgpt.com/g/project/c/reviewer");
        await sendReport(registry, request, "approved");
        return { text: "" };
      },
    };
    const result = await new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: true,
    }).run();
    assert.equal(calls, 1);
    assert.equal(result.completedRuns, 1);
  });
});

test("pre-submit saved Project redirect retires token and allows explicit safe retry", async () => {
  await fixture(async (root, registry, store) => {
    const session = "https://chatgpt.com/g/project/c/reviewer";
    await store.save({ currentWorkerId: "reviewer", completedRuns: 0,
      browserWorkersStarted: ["reviewer"], sessions: { reviewer: session }, task });
    let firstToken = "";
    const blocked: Executor = { kind: "chatgpt_browser", async run(request) {
      firstToken = tokenFor(request);
      throw new BrowserResumeUnavailableError(session, "Project route canonicalization failed before submission");
    }};
    const options = { projectRoot: root, workflow, stateStore: store, enableWorkerReports: true };
    await assert.rejects(new Orchestrator({
      ...options, executors: new Map([["chatgpt_browser", blocked]]),
    }).run(), BrowserResumeUnavailableError);
    assert.equal((await store.load())?.activeReport, undefined);
    assert.equal((await store.load())?.sessions.reviewer, session);
    let calls = 0;
    const working: Executor = { kind: "chatgpt_browser", async run(request) {
      calls++;
      assert.notEqual(tokenFor(request), firstToken);
      await sendReport(registry, request, "approved");
      return { text: "", sessionId: session };
    }};
    const result = await new Orchestrator({
      ...options, executors: new Map([["chatgpt_browser", working]]),
    }).run();
    assert.equal(result.completedRuns, 1);
    assert.equal(result.mainAgentReviewPending, true);
    assert.equal(calls, 1);
  });
});

test("no-MCP post-submit loss cannot replay the same browser turn after restart", async () => {
  await fixture(async (root, _registry, store) => {
    const session = "https://chatgpt.com/g/project/c/reviewer";
    const uncertain: Executor = { kind: "chatgpt_browser", async run(request) {
      await request.onSession?.(session);
      assert.match(request.browserTurnId ?? "", /^0:reviewer:[a-f0-9]{64}$/);
      assert.equal(request.reportTurn, undefined, "MCP reports are disabled");
      throw new Error("Ambiguous post-submit SSE loss");
    }};
    const options = { projectRoot: root, workflow, stateStore: store, enableWorkerReports: false };
    await assert.rejects(new Orchestrator({
      ...options, executors: new Map([["chatgpt_browser", uncertain]]),
    }).run(), /Ambiguous post-submit/);
    const persisted = await store.load();
    assert.equal(persisted?.completedRuns, 0);
    assert.ok(persisted?.activeReport, "even without MCP, an opaque attempt is persisted");
    let reruns = 0;
    const unsafe: Executor = { kind: "chatgpt_browser", async run() {
      reruns++; throw Error("Duplicate submission");
    }};
    await assert.rejects(new Orchestrator({
      ...options, executors: new Map([["chatgpt_browser", unsafe]]),
    }).run(), /Unresolved prior browser turn/);
    assert.equal(reruns, 0);
  });
});

test("no-MCP success accepts a single machine-valid final answer and releases attempt marker", async () => {
  await fixture(async (root, _registry, store) => {
    const executor: Executor = { kind: "chatgpt_browser", async run(request) {
      assert.equal(request.reportTurn, undefined);
      await request.onSession?.("https://chatgpt.com/g/project/c/reviewer");
      return { text: 'Complete\nDEVOS_RESULT {"status":"approved"}' };
    }};
    const result = await new Orchestrator({
      projectRoot: root, workflow, stateStore: store,
      executors: new Map([["chatgpt_browser", executor]]),
      enableWorkerReports: false,
    }).run();
    assert.equal(result.completedRuns, 1);
    assert.equal(result.mainAgentReviewPending, true);
    assert.equal(result.activeReport, undefined);
  });
});
