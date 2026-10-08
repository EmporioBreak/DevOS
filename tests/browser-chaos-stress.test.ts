import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { JsonStateStore } from "../src/json-state-store.js";
import { DevosToolRegistry } from "../src/mcp-tools/registry.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { SharedBrowserExecutor, browserRuntimePaths, startSharedBrowserServer, closeSharedBrowserRuntime } from "../src/shared-browser-runtime.js";
import type { Executor, WorkerRequest } from "../src/executor.js";
import type { Workflow, WorkerStatus } from "../src/workflow.js";

function token(request: WorkerRequest) {
  const proof = /turn_token=([a-f0-9]{64})/.exec(request.prompt)?.[1];
  assert.ok(proof);
  return proof;
}
function parseTurn(request: WorkerRequest): number {
  const turn = /turn=(\d+), turn_token=/.exec(request.prompt)?.[1];
  assert.ok(turn);
  return Number(turn);
}
const wf = (issue: number): Workflow => ({
  version: 1, task: { repo: "Stress/DevOS", issue }, owner: { mode: "main_agent" }, start: "developer",
  workers: [
    { id: "developer", executor: "chatgpt_browser", prompt: "Implement.", on: { done: "reviewer" } },
    { id: "reviewer", executor: "chatgpt_browser", prompt: "Review.", on: { changes_requested: "developer", approved: null } },
  ],
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("CHAOS: 32 isolated tasks x six turns, two worker tabs, MCP completion, no cross-task token mixing", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-chaos-"));
  const registry = new DevosToolRegistry(root);
  const allProofs = new Set<string>();
  const saved = new Map<string, string>();
  let sends = 0;
  let wrongTokenRejected = 0;
  try {
    const tasks = Array.from({ length: 32 }, (_, i) => i + 30_000);
    const worker: Executor = {
      kind: "chatgpt_browser",
      async run(request) {
        const turn = parseTurn(request);
        const ref = /Shared task context is in GitHub: Stress\/DevOS Issue #(\d+)/.exec(request.prompt)?.[1];
        assert.ok(ref);
        const issue = Number(ref);
        const name = request.workerId!;
        const key = issue + ":" + name;
        sends++;
        const proof = token(request);
        assert.ok(!allProofs.has(proof), "worker tokens must never repeat");
        allProofs.add(proof);
        assert.match(request.browserTurnId!, new RegExp("^" + turn + ":" + name + ":[a-f0-9]{64}$"));
        const session = "https://chatgpt.com/g/safe-project/c/task-" + issue + "-" + name;
        assert.equal(saved.get(key) ?? session, session);
        saved.set(key, session);
        await request.onSession?.(session);
        const wrong = await registry.call("devos_worker_report", {
          repo: "Stress/DevOS", issue, worker_id: name, turn, turn_token: "f".repeat(64),
          status: "approved", summary: "Attempt to forge other worker",
        });
        assert.equal(wrong.isError, true);
        wrongTokenRejected++;
        const status: WorkerStatus = name === "developer" ? "done" :
          turn < 5 ? "changes_requested" : "approved";
        const params = {
          repo: "Stress/DevOS", issue, worker_id: name, turn, turn_token: proof,
          status, summary: "Stress turn complete; evidence committed",
        };
        const result = await registry.call("devos_worker_report", params);
        assert.equal(result.isError, undefined);
        assert.deepEqual(await registry.call("devos_worker_report", params), result);
        // Every 4th turn represents a dead or silent browser IPC even after
        // the model reported. Orchestrator must proceed via MCP alone.
        if (turn % 4 === 0) return await new Promise<never>(() => {});
        await delay(turn % 3);
        return { text: "", sessionId: session };
      },
    };
    // Eight tasks concurrently stress the real local state/report filesystem
    // without opening unrelated ChatGPT conversations or modifying actual Issues.
    for (let batch = 0; batch < tasks.length; batch += 8) {
      const results = await Promise.all(tasks.slice(batch, batch + 8).map(async issue => {
        const workflow = wf(issue);
        const state = new JsonStateStore(root, workflow.task);
        const result = await new Orchestrator({
          projectRoot: root, workflow, stateStore: state,
          executors: new Map([["chatgpt_browser", worker]]), enableWorkerReports: true,
        }).run();
        assert.equal(result.completedRuns, 6, "6 exact worker turns per task");
        assert.equal(result.mainAgentReviewPending, true);
        assert.equal(Object.keys(result.sessions).length, 2);
        assert.equal(result.activeReport, undefined);
        return issue;
      }));
      assert.equal(results.length, 8);
    }
    assert.equal(sends, 192);
    assert.equal(allProofs.size, 192);
    assert.equal(wrongTokenRejected, 192);
    assert.equal(saved.size, 64, "same task/worker preserves tab identity");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CHAOS: one browser runtime deduplicates reconnects, keeps 10 worker-turn identities distinct", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-chaos-ipc-"));
  const task = { repo: "Stress/DevOS", issue: 314159 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  const calls: string[] = [];
  const executor = {
    async run(request: WorkerRequest) {
      calls.push(request.browserTurnId!);
      await request.onSession?.("https://chatgpt.com/g/one/c/" + request.workerId);
      await delay(2);
      return { text: "done", sessionId: "https://chatgpt.com/g/one/c/" + request.workerId };
    },
    async close() {},
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const client = new SharedBrowserExecutor(paths.socket);
    // Same task, same browser server, 10 distinct worker tabs, two clients
    // racing each same turn (simulates IPC reconnect). Separate tokens for
    // restarted task with identical worker/turn index must create fresh work.
    for (let batch = 0; batch < 8; batch++) {
      const turnCalls = Array.from({ length: 10 }, (_, i) => {
        const workerId = "w-" + i;
        const request = {
          projectRoot: root, prompt: "work",
          workerId, browserTurnId: "0:" + workerId + ":" + "a".repeat(60) + String(batch).padStart(4, "0"),
        };
        return Promise.all([client.run(request), client.run(request)]).then(([a, b]) => {
          assert.deepEqual(a, b);
        });
      });
      await Promise.all(turnCalls);
    }
    assert.equal(calls.length, 80, "two clients for one turn never submit twice");
    assert.equal(new Set(calls).size, 80);
  } finally {
    await closeSharedBrowserRuntime(root, task);
    await rm(root, { recursive: true, force: true });
  }
});

test("CHAOS: one browser context uses distinct worker pages and reconstructs tabs", async () => {
  const pages: Array<Page> = [];
  const fakePage = (id: string) => {
    let currentUrl = "https://chatgpt.com/g/one/c/" + id;
    return {
      id, url: () => currentUrl,
      isClosed: () => false, async goto(url: string) {
        assert.ok(url.startsWith("https://chatgpt.com/g/one/c/"));
        currentUrl = url;
      },
    } as unknown as Page;
  };
  const context = {
    pages: () => pages,
    async newPage() {
      const page = fakePage("new-" + pages.length);
      pages.push(page);
      return page;
    },
  } as unknown as BrowserContext;
  const executor = new ChatGptBrowserExecutor({
    projectUrl: "https://chatgpt.com/g/one/project", profileDir: "/unused", headless: false,
  });
  const get = (workerId: string, knownBrowserSessions: Record<string, string>) =>
    (executor as any).getWorkerPage({ workerId, knownBrowserSessions }, context) as Promise<Page>;
  const workerSessions = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => ["worker-" + i, "https://chatgpt.com/g/one/c/worker-" + i]),
  );
  const first = await get("worker-0", {});
  const tabs = [first];
  for (let i = 1; i < 10; i++) tabs.push(await get("worker-" + i, {}));
  assert.equal(new Set(tabs).size, 10);
  assert.equal(await get("worker-0", {}), first);
  assert.equal(pages.length, 10);
  // Reconstruct the entire prior tab map when one shared browser context
  // is recreated after a crash, without submitting any prompts.
  const restored = new ChatGptBrowserExecutor({
    projectUrl: "https://chatgpt.com/g/one/project", profileDir: "/unused", headless: false,
  });
  const next = await (restored as any).getWorkerPage({
    workerId: "worker-4", knownBrowserSessions: workerSessions,
  }, { pages: () => [], newPage: async () => fakePage("replacement") });
  assert.ok(next, "reconstructed worker tab");
});

test("CHAOS: 100 repeated turns on one tab do not accumulate network listeners", { timeout: 20_000 }, async () => {
  const saved = "https://chatgpt.com/g/one/c/developer";
  let current = saved;
  let sends = 0;
  const listeners = new Map<string, Set<Function>>();
  const locator = {
    first() { return this; }, async fill() {}, async waitFor() {},
    async isVisible() { return true; }, async click() { sends++; }, async press() { sends++; },
  };
  const page = {
    on(event: string, fn: Function) {
      const set = listeners.get(event) ?? new Set<Function>();
      set.add(fn); listeners.set(event, set);
    },
    off(event: string, fn: Function) { listeners.get(event)?.delete(fn); },
    url: () => current,
    isClosed: () => false,
    async goto(target: string) { current = target; return { status: () => 200 }; },
    locator: () => locator,
    async evaluate(fn: Function) {
      if (fn.toString().includes("document.body")) return "";
      if (fn.toString().includes("__DEVOS_ARM_STREAM__")) return 1;
      return { text: 'Done\nDEVOS_RESULT {"status":"done"}', failed: false };
    },
    async waitForFunction() {},
  } as unknown as Page;
  const context = { pages: () => [page], async newPage() { throw Error("Unexpected second page"); } };
  const executor = new ChatGptBrowserExecutor({
    projectUrl: "https://chatgpt.com/g/one/project", profileDir: "/unused", headless: false,
  }, 1_000);
  Object.assign(executor, { context });
  for (let i = 0; i < 100; i++) {
    const output = await executor.run({ projectRoot: "/project", workerId: "developer",
      prompt: "Same task, distinct turn " + i, sessionId: saved });
    assert.match(output.text, /DEVOS_RESULT/);
    assert.equal(listeners.get("response")?.size ?? 0, 0, "backend response observers must be detached");
    assert.equal(listeners.get("request")?.size ?? 0, 0, "submit request observers must be detached");
  }
  assert.equal(sends, 100);
});
