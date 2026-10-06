import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { chromium, type BrowserContext } from "playwright";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import type { Executor } from "../src/executor.js";
import { Orchestrator, type RunState, type StateStore } from "../src/orchestrator.js";
import type { Workflow } from "../src/workflow.js";

const project = "https://chatgpt.com/g/one/project";
const saved = "https://chatgpt.com/g/one/c/saved";
const created = "https://chatgpt.com/g/one/c/created";
function fixture(options: { phase?: "goto" | "wait" | "fill" | "newPage"; failures?: number; error?: string; destination?: string; status?: number; body?: string; historyBody?: boolean; sendError?: boolean; responseError?: boolean; slow?: boolean; closeSlow?: boolean; backendDenied?: boolean; backendDeniedDuringWait?: boolean; backendDeniedDuringFill?: boolean; rootRedirect?: boolean } = {}) {
  let attempts = 0, sends = 0, fills = 0, closes = 0;
  const urls: string[] = [];
  let responseListener: ((response: any) => void) | undefined;
  const denied = () => responseListener?.({
    url: () => "https://chatgpt.com/backend-api/accounts/check",
    status: () => 403,
    headers: () => ({ "content-type": "text/html" }),
  });
  const locator = {
    first() { return this; },
    async waitFor() {
      if (options.backendDeniedDuringWait) {
        setTimeout(denied, 10);
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      if (options.phase === "wait") fail();
    },
    async fill() {
      fills++;
      if (options.backendDeniedDuringFill) denied();
      if (options.phase === "fill") fail();
    },
    async isVisible() { return true; },
    async click() { sends++; url = url === saved ? saved : created; if (options.sendError) throw new Error("Target page crashed during click"); },
    async press() { await this.click(); },
  };
  let url = project;
  function fail() { if (attempts <= (options.failures ?? 1)) throw new Error(options.error ?? "Timeout waiting for composer"); }
  const page = {
    on(_event: string, listener: (response: any) => void) { responseListener = listener; },
    url: () => url,
    async goto(target: string) {
      if (options.backendDenied) denied();
      urls.push(target); url = options.rootRedirect && attempts === 1 ? "https://chatgpt.com/" : options.destination ?? target;
      if (options.slow) await new Promise(resolve => setTimeout(resolve, 60));
      if (options.phase === "goto") fail();
      return { status: () => options.status ?? 200 };
    },
    locator: () => locator,
    async evaluate(fn: Function) {
      if (fn.toString().includes("document.body")) {
        if (options.historyBody) return runInNewContext(`(${fn.toString()})()`, { document: { body: { innerText: options.body }, querySelector: () => ({}), querySelectorAll: () => [] } });
        return options.body ?? "";
      }
      if (fn.toString().includes("__DEVOS_ARM_STREAM__")) return 1;
      return { text: 'DEVOS_RESULT {"status":"done"}', failed: false };
    },
    async waitForFunction() { if (options.responseError) throw new Error("Execution context was destroyed"); },
    async close() { closes++; if (options.closeSlow) await new Promise(resolve => setTimeout(resolve, 150)); },
  };
  const context = {
    async newPage() { attempts++; if (options.phase === "newPage") fail(); return page; },
    async close() {},
  };
  const executor = new ChatGptBrowserExecutor({ projectUrl: project, profileDir: "/unused", browserChannel: "chrome", headless: true }, options.slow ? 30 : 500);
  Object.assign(executor, { context });
  return { executor, urls, changeConversation: () => { url = "https://chatgpt.com/g/one/c/unrelated"; }, attempts: () => attempts, sends: () => sends, fills: () => fills, closes: () => closes };
}

for (const phase of ["goto", "wait", "fill"] as const) {
  test(`transient ${phase} retries only the same saved conversation then submits once`, async () => {
    const f = fixture({ phase });
    const output = await f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true });
    assert.equal(output.sessionId, saved);
    assert.deepEqual(f.urls, [saved, saved]);
    assert.equal(f.sends(), 1);
  });
}

test("transient exhaustion is at most three attempts and never submits", async () => {
  const f = fixture({ phase: "wait", failures: 99 });
  await assert.rejects(f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }), /attempt=3.*phase=.*Timeout/);
  assert.deepEqual(f.urls, [saved, saved, saved]);
  assert.equal(f.sends(), 0);
});

for (const options of [
  { destination: "https://chatgpt.com/g/other/project" },
  { destination: "https://chatgpt.com/auth/login" },
  { status: 401 }, { status: 403 }, { status: 404 },
  { body: "Unable to load conversation" },
  { body: "Just a moment… Cloudflare challenge" },
  { phase: "goto" as const, error: "net::ERR_CERT_AUTHORITY_INVALID" },
]) {
  test(`definitive scope/auth/unavailable failure is not retried: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }));
    assert.equal(f.urls.length, 1);
    assert.equal(f.sends(), 0);
  });
}

test("fresh task retries Project navigation and persists only its Project conversation", async () => {
  const f = fixture({ phase: "goto" });
  let session: string | undefined;
  const output = await f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true, onSession: id => { session = id; } });
  assert.deepEqual(f.urls, [project, project]);
  assert.equal(session, created);
  assert.equal(output.sessionId, created);
  assert.equal(f.sends(), 1);
});

for (const sendError of [true, false]) {
  test(`ambiguous ${sendError ? "click" : "response"} failure preserves fresh identity without replay`, async () => {
    const f = fixture({ sendError, responseError: !sendError });
    let session: string | undefined;
    await assert.rejects(f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true, onSession: id => { session = id; } }), /post-submit.*not replayed/);
    assert.equal(session, created);
    assert.equal(f.sends(), 1);
    assert.equal(f.urls.length, 1);
  });
}

test("preparation has a total deadline even when an operation ignores its timeout", async () => {
  const f = fixture({ slow: true });
  const started = Date.now();
  await assert.rejects(f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true }), /deadline|Timeout/);
  assert.ok(Date.now() - started < 200);
  assert.equal(f.sends(), 0);
});

test("closed persistent context is discarded and relaunched headless with the same profile", async t => {
  const closeHandlers: Array<() => void> = [];
  const launches: Array<{ profile: string; headless: boolean | undefined }> = [];
  const f = fixture();
  const existing = (f.executor as unknown as { context: unknown }).context;
  Object.assign(f.executor, { context: undefined });
  t.mock.method(chromium, "launchPersistentContext", async (profile: string, options: { headless?: boolean }) => {
    launches.push({ profile, headless: options.headless });
    return { ...(existing as object), async addInitScript() {}, on(_event: string, handler: () => void) { closeHandlers.push(handler); } } as unknown as BrowserContext;
  });
  // Use a real writable project directory, no browser or ChatGPT network.
  Object.assign(f.executor, { config: { projectUrl: project, profileDir: process.cwd() + "/.devos/test-profile", browserChannel: "chrome", headless: true } });
  await f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true });
  closeHandlers[0]?.();
  await f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true });
  assert.equal(launches.length, 2);
  assert.ok(launches.every(item => item.headless === true && item.profile.endsWith("/.devos/test-profile")));
});

test("transient account-loading root redirect retries Project rather than submitting standalone", async () => {
  const f = fixture({ phase: "wait", rootRedirect: true });
  const output = await f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true });
  assert.deepEqual(f.urls, [project, project]);
  assert.equal(output.sessionId, created);
  assert.equal(f.sends(), 1);
});

for (const phase of ["newPage", "goto"] as const) {
  test(`${phase} closed/crashed context retries saved identity with persistent profile`, async t => {
    const f = fixture({ phase, error: phase === "newPage" ? "Target page, context or browser has been closed" : "Target page crashed" });
    const context = (f.executor as unknown as { context: object }).context;
    let launches = 0;
    Object.assign(f.executor, { config: { projectUrl: project, profileDir: process.cwd() + "/.devos/test-profile", browserChannel: "chrome", headless: true } });
    t.mock.method(chromium, "launchPersistentContext", async (_profile: string, options: { headless?: boolean }) => {
      launches++;
      assert.equal(options.headless, true);
      return { ...context, async addInitScript() {}, on() {} } as unknown as BrowserContext;
    });
    const output = await f.executor.run({ projectRoot: "/project", prompt: "Work", sessionId: saved, enforceProjectScope: true });
    assert.equal(output.sessionId, saved);
    assert.equal(f.attempts(), 2);
    assert.equal(launches, 1);
    assert.ok(f.urls.every(url => url === saved));
    assert.equal(f.sends(), 1);
  });
}

test("fresh response changing conversation fails with the originally persisted identity", async () => {
  const f = fixture();
  let session: string | undefined;
  await assert.rejects(f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true, onSession: id => { session = id; f.changeConversation(); } }), /changed.*conversation|identity/);
  assert.equal(session, created);
  assert.equal(f.sends(), 1);
});

test("invalid saved Project scope stops before opening a page", async () => {
  const f = fixture();
  await assert.rejects(f.executor.run({ projectRoot: "/project", prompt: "Work", sessionId: "https://chatgpt.com/g/other/c/saved", enforceProjectScope: true }), /escaped/);
  assert.equal(f.attempts(), 0);
});

test("backend HTML 403 challenge is definitive even when composer wait times out", async () => {
  const f = fixture({ backendDenied: true, phase: "wait", failures: 99 });
  await assert.rejects(f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }), /challenge.*HTTP 403/);
  assert.deepEqual(f.urls, [saved]);
  assert.equal(f.sends(), 0);
});

test("saved conversation discussing challenges is not mistaken for an authentication screen", async () => {
  const f = fixture({ historyBody: true, body: "Audit Cloudflare challenge and Unable to load conversation errors" });
  const output = await f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true });
  assert.equal(output.sessionId, saved);
  assert.equal(f.sends(), 1);
});

test("slow cleanup cannot extend the total preparation deadline", async () => {
  const f = fixture({ slow: true, closeSlow: true });
  const started = Date.now();
  await assert.rejects(f.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true }), /deadline/);
  assert.ok(Date.now() - started < 120, "cleanup must share the preparation deadline");
  assert.equal(f.sends(), 0);
});


test("asynchronous backend HTML 403 remains definitive when preparation deadline wins", async () => {
  const f = fixture({ backendDeniedDuringWait: true });
  await assert.rejects(
    f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }),
    /challenge.*HTTP 403/,
  );
  assert.deepEqual(f.urls, [saved]);
  assert.equal(f.sends(), 0);
});

test("backend HTML 403 during prompt preparation stops before irreversible submit", async () => {
  const f = fixture({ backendDeniedDuringFill: true });
  await assert.rejects(
    f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }),
    /challenge.*HTTP 403/,
  );
  assert.deepEqual(f.urls, [saved]);
  assert.equal(f.sends(), 0);
});


class RecoveryStateStore implements StateStore {
  constructor(public state: RunState | null = null) {}
  async load(): Promise<RunState | null> { return this.state; }
  async save(state: RunState): Promise<void> { this.state = structuredClone(state); }
  async clear(): Promise<void> { this.state = null; }
}

function recoveryWorkflow(): Workflow {
  return {
    version: 1,
    task: { repo: "owner/product", issue: 620, pr: 63 },
    start: "browser",
    workers: [
      { id: "browser", executor: "chatgpt_browser", prompt: "Work", on: { done: null } },
    ],
  };
}

test("orchestrator ordinary run retries a proven first-turn pre-submit 403 without replacing task state", async () => {
  const options = { status: 403 };
  const f = fixture(options);
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore({
    currentWorkerId: "browser",
    completedRuns: 2,
    sessions: { other: "https://chatgpt.com/g/one/c/other" },
    browserWorkersStarted: ["other"],
    task: workflow.task,
  });

  await assert.rejects(
    new Orchestrator({
      projectRoot: "/project",
      workflow,
      executors: new Map([["chatgpt_browser", f.executor]]),
      stateStore: store,
    }).run(),
    /HTTP 403/,
  );

  assert.deepEqual(store.state?.browserPreSubmitRetry, ["browser"]);
  assert.deepEqual(store.state?.sessions, { other: "https://chatgpt.com/g/one/c/other" });
  assert.deepEqual(store.state?.task, workflow.task);
  assert.equal(f.sends(), 0);

  options.status = 200;
  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", f.executor]]),
    stateStore: store,
  }).run();

  assert.equal(result.sessions.browser, created);
  assert.equal(result.sessions.other, "https://chatgpt.com/g/one/c/other");
  assert.equal(result.browserPreSubmitRetry?.includes("browser"), false);
  assert.deepEqual(result.task, workflow.task);
  assert.equal(f.sends(), 1);
});

test("orchestrator ordinary run retries a proven first-turn transient exhaustion", async () => {
  const options: { phase?: "wait"; failures?: number } = { phase: "wait", failures: 99 };
  const f = fixture(options);
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore();

  await assert.rejects(
    new Orchestrator({
      projectRoot: "/project",
      workflow,
      executors: new Map([["chatgpt_browser", f.executor]]),
      stateStore: store,
    }).run(),
    /attempt=3.*Timeout/,
  );
  assert.deepEqual(store.state?.browserPreSubmitRetry, ["browser"]);
  assert.equal(f.sends(), 0);

  options.failures = 0;
  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", f.executor]]),
    stateStore: store,
  }).run();
  assert.equal(result.sessions.browser, created);
  assert.equal(f.sends(), 1);
});

test("unknown fresh browser failure clears safe retry permission and cannot start a replacement", async () => {
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore({
    currentWorkerId: "browser",
    completedRuns: 0,
    sessions: {},
    browserWorkersStarted: ["browser"],
    browserPreSubmitRetry: ["browser"],
    task: workflow.task,
  });
  let calls = 0;
  const unknown: Executor = {
    kind: "chatgpt_browser",
    async run() {
      calls++;
      throw new Error("unknown executor failure");
    },
  };

  await assert.rejects(
    new Orchestrator({
      projectRoot: "/project",
      workflow,
      executors: new Map([["chatgpt_browser", unknown]]),
      stateStore: store,
    }).run(),
    /unknown executor failure/,
  );
  assert.deepEqual(store.state?.browserPreSubmitRetry, []);

  await assert.rejects(
    new Orchestrator({
      projectRoot: "/project",
      workflow,
      executors: new Map([["chatgpt_browser", unknown]]),
      stateStore: store,
    }).run(),
    /Missing saved browser session/,
  );
  assert.equal(calls, 1);
});

test("ambiguous post-submit fresh failure preserves created identity instead of authorizing fresh replacement", async () => {
  const f = fixture({ sendError: true });
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore();

  await assert.rejects(
    new Orchestrator({
      projectRoot: "/project",
      workflow,
      executors: new Map([["chatgpt_browser", f.executor]]),
      stateStore: store,
    }).run(),
    /post-submit.*not replayed/,
  );

  assert.equal(store.state?.sessions.browser, created);
  assert.equal(store.state?.browserPreSubmitRetry?.includes("browser"), false);
  assert.equal(f.sends(), 1);
});
