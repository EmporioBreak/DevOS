import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonStateStore } from "../src/json-state-store.js";
import { runInNewContext } from "node:vm";
import type { BrowserContext } from "playwright-core";
import { ChatGptBrowserExecutor, chatGptBrowserDeps } from "../src/chatgpt-browser-executor.js";
import type { Executor } from "../src/executor.js";
import { Orchestrator, type RunState, type StateStore } from "../src/orchestrator.js";
import type { Workflow } from "../src/workflow.js";

const project = "https://chatgpt.com/g/one/project";
const saved = "https://chatgpt.com/g/one/c/saved";
const created = "https://chatgpt.com/g/one/c/created";
function fixture(options: { phase?: "goto" | "wait" | "fill" | "newPage"; failures?: number; error?: string; destination?: string; status?: number; statusSequence?: number[]; responseHeaders?: Record<string,string>; body?: string; bodySequence?: string[]; historyBody?: boolean; sendError?: boolean; noConversation?: boolean; responseError?: boolean; slow?: boolean; closeSlow?: boolean; backendDenied?: boolean; backendDeniedCount?: number; backendDeniedDuringWait?: boolean; backendDeniedDuringFill?: boolean; rootRedirect?: boolean } = {}) {
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
    async click() { sends++; url = options.noConversation ? project : url === saved ? saved : created; if (options.sendError) throw new Error("Target page crashed during click"); },
    async press() { await this.click(); },
  };
  let url = project;
  function fail() {
    const attempt = options.phase === "newPage" ? attempts : urls.length;
    if (attempt <= (options.failures ?? 1)) throw new Error(options.error ?? "Timeout waiting for composer");
  }
  const page = {
    on(_event: string, listener: (response: any) => void) { responseListener = listener; },
    url: () => url,
    async goto(target: string) {
      if (options.backendDenied && urls.length < (options.backendDeniedCount ?? Infinity)) denied();
      urls.push(target); url = options.rootRedirect && urls.length === 1 ? "https://chatgpt.com/" : options.destination ?? target;
      if (options.slow) await new Promise(resolve => setTimeout(resolve, 60));
      if (options.phase === "goto") fail();
      return { status: () => options.statusSequence?.[Math.min(urls.length - 1, options.statusSequence.length - 1)] ?? options.status ?? 200,
        headers: () => options.responseHeaders ?? {} };
    },
    locator: () => locator,
    async evaluate(fn: Function) {
      if (fn.toString().includes("document.body")) {
        const body = options.bodySequence?.[Math.min(urls.length - 1, options.bodySequence.length - 1)] ?? options.body ?? "";
        if (options.historyBody) return runInNewContext(`(${fn.toString()})()`, { document: { body: { innerText: body }, querySelector: () => ({}), querySelectorAll: () => [] } });
        return body;
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
  const executor = new ChatGptBrowserExecutor({ projectUrl: project, profileDir: "/unused", headless: true }, options.slow ? 30 : 500);
  Object.assign(executor, { context });
  return { executor, urls, reopen: () => Object.assign(executor, { context }), changeConversation: () => { url = "https://chatgpt.com/g/one/c/unrelated"; }, attempts: () => attempts, sends: () => sends, fills: () => fills, closes: () => closes };
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
  t.mock.method(chatGptBrowserDeps, "loadIdentity", async () => ({
    schema: 1 as const,
    os: "macos" as const,
    preset: { userAgent: "stable-test-preset" },
  }));

  t.mock.method(chatGptBrowserDeps, "launchPersistentContext", async (profile: string, options: Parameters<typeof chatGptBrowserDeps.launchPersistentContext>[1]) => {
    launches.push({ profile, headless: options.headless });
    return { ...(existing as object), async addInitScript() {}, on(_event: string, handler: () => void) { closeHandlers.push(handler); } } as unknown as BrowserContext;
  });
  // Use a real writable project directory, no browser or ChatGPT network.
  Object.assign(f.executor, { config: { projectUrl: project, profileDir: process.cwd() + "/.devos/test-profile", headless: true } });
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
    Object.assign(f.executor, { config: { projectUrl: project, profileDir: process.cwd() + "/.devos/test-profile", headless: true } });
    t.mock.method(chatGptBrowserDeps, "loadIdentity", async () => ({
      schema: 1 as const,
      os: "macos" as const,
      preset: { userAgent: "stable-test-preset" },
    }));

    t.mock.method(chatGptBrowserDeps, "launchPersistentContext", async (_profile: string, options: Parameters<typeof chatGptBrowserDeps.launchPersistentContext>[1]) => {
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

test("backend HTML 403 challenge retries with a bounded same-tab budget before giving up", async () => {
  const f = fixture({ backendDenied: true, phase: "wait", failures: 99 });
  await assert.rejects(f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }), /challenge.*HTTP 403/);
  assert.deepEqual(f.urls, [saved, saved, saved]);
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


test("asynchronous backend HTML 403 cannot outlive the preparation deadline", async () => {
  const f = fixture({ backendDeniedDuringWait: true });
  await assert.rejects(
    f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }),
    /challenge.*HTTP 403/,
  );
  assert.deepEqual(f.urls, [saved]);
  assert.equal(f.sends(), 0);
});

test("backend HTML 403 during preparation retries but never submits an unready prompt", async () => {
  const f = fixture({ backendDeniedDuringFill: true });
  await assert.rejects(
    f.executor.run({ projectRoot: "/project", sessionId: saved, prompt: "Work", enforceProjectScope: true }),
    /challenge.*HTTP 403/,
  );
  assert.deepEqual(f.urls, [saved, saved, saved]);
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

  f.reopen();
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

  f.reopen();
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
    /Unresolved prior browser turn/,
  );
  assert.equal(calls, 1);
  assert.equal(store.state?.activeReport?.workerId, "browser", "ambiguous attempt must remain persisted");
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
  assert.notEqual(store.state?.browserPreSubmitRetry?.includes("browser"), true);
  assert.equal(f.sends(), 1);
});


test("saved conversation remains identical across a pre-submit failure and ordinary retry", async () => {
  const options = { status: 403 };
  const f = fixture(options);
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore({
    currentWorkerId: "browser",
    completedRuns: 1,
    sessions: { browser: saved, other: "https://chatgpt.com/g/one/c/other" },
    browserWorkersStarted: ["browser", "other"],
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
  assert.equal(store.state?.sessions.browser, saved);
  assert.equal(f.sends(), 0);

  f.reopen();
  options.status = 200;
  const result = await new Orchestrator({
    projectRoot: "/project",
    workflow,
    executors: new Map([["chatgpt_browser", f.executor]]),
    stateStore: store,
  }).run();

  assert.equal(result.sessions.browser, saved);
  assert.equal(result.sessions.other, "https://chatgpt.com/g/one/c/other");
  // Unknown/non-browser sessions are preserved in task state but are never
  // treated as browser tabs during reconstruction.
  assert.deepEqual(f.urls, [saved, saved]);
  assert.equal(f.sends(), 1);
});

for (const failure of ["auth", "transient"] as const) {
  test(`durable ordinary run resumes proven first-turn ${failure} failure`, async t => {
    const root = await mkdtemp(join(process.cwd(), ".devos", "presubmit-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workflow = { ...recoveryWorkflow(), owner: { mode: "main_agent" as const } };
    const store = new JsonStateStore(root, workflow.task);
    await store.save({ currentWorkerId: "browser", completedRuns: 2, sessions: { other: saved }, browserWorkersStarted: ["other"], task: workflow.task });
    const options = { status: failure === "auth" ? 403 : 200, phase: "wait" as const, failures: failure === "transient" ? 99 : 0 };
    const f = fixture(options);
    const runOptions = { projectRoot: root, workflow, executors: new Map([["chatgpt_browser", f.executor]]) };
    await assert.rejects(new Orchestrator({ ...runOptions, stateStore: store }).run(), failure === "auth" ? /HTTP 403/ : /attempt=3.*Timeout/);
    const persisted = await new JsonStateStore(root, workflow.task).load();
    assert.deepEqual(persisted?.browserPreSubmitRetry, ["browser"]);
    assert.deepEqual(persisted?.sessions, { other: saved });
    assert.deepEqual(persisted?.task, workflow.task);
    assert.equal(f.sends(), 0);
    f.reopen();
    options.status = 200; options.failures = 0;
    const result = await new Orchestrator({ ...runOptions, stateStore: new JsonStateStore(root, workflow.task) }).run();
    assert.equal(result.sessions.browser, created);
    assert.equal(result.sessions.other, saved);
    assert.deepEqual(result.task, workflow.task);
    assert.equal(result.completedRuns, 3);
    assert.equal(result.browserPreSubmitRetry?.includes("browser"), false);
    assert.equal(f.sends(), 1);
  });
}

test("safe fresh retry permission is consumed before another executor attempt can submit", async () => {
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore({ currentWorkerId: "browser", completedRuns: 0, sessions: {}, browserWorkersStarted: ["browser"], browserPreSubmitRetry: ["browser"], task: workflow.task });
  let permissionAtEntry: boolean | undefined;
  const executor: Executor = { kind: "chatgpt_browser", async run() {
    permissionAtEntry = (await store.load())?.browserPreSubmitRetry?.includes("browser");
    throw new Error("unknown after execution begins");
  } };
  await assert.rejects(new Orchestrator({ projectRoot: "/project", workflow, executors: new Map([["chatgpt_browser", executor]]), stateStore: store }).run(), /unknown after execution/);
  assert.equal(permissionAtEntry, false, "a process interruption cannot leave permission to replay an ambiguous attempt");
});

test("possible submission without a saved URL revokes safe retry and cannot create a replacement", async () => {
  const options = { status: 403, sendError: true, noConversation: true };
  const f = fixture(options);
  const workflow = recoveryWorkflow();
  const store = new RecoveryStateStore();
  const runOptions = { projectRoot: "/project", workflow, executors: new Map([["chatgpt_browser", f.executor]]), stateStore: store };
  await assert.rejects(new Orchestrator(runOptions).run(), /HTTP 403/);
  f.reopen();
  options.status = 200;
  await assert.rejects(new Orchestrator(runOptions).run(), /post-submit.*not replayed/);
  assert.notEqual(store.state?.browserPreSubmitRetry?.includes("browser"), true);
  assert.equal(store.state?.sessions.browser, undefined);
  await assert.rejects(new Orchestrator(runOptions).run(), /Unresolved prior browser turn/);
  assert.deepEqual(f.urls, [project, project]);
  assert.equal(f.sends(), 1);
  assert.equal(store.state?.activeReport?.workerId, "browser", "unknown submit must block any replay");
});

test("temporary 503, 408 and 425 navigation errors recover on the exact saved tab", async () => {
  for (const status of [503, 408, 425]) {
    const f=fixture({statusSequence:[status,200]});
    const output=await f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work",enforceProjectScope:true});
    assert.equal(output.sessionId,saved);
    assert.deepEqual(f.urls,[saved,saved]);
    assert.equal(f.attempts(),1,"no new browser page may replace the worker tab");
    assert.equal(f.closes(),0);
    assert.equal(f.sends(),1);
  }
});
test("Cloudflare passive challenge can settle after bounded same-tab reload", async () => {
  const f=fixture({bodySequence:["Just a moment… Cloudflare challenge",""]});
  const output=await f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work",enforceProjectScope:true});
  assert.equal(output.sessionId,saved);
  assert.deepEqual(f.urls,[saved,saved]);
  assert.equal(f.attempts(),1);
  assert.equal(f.closes(),0);
  assert.equal(f.sends(),1);
});
test("one upstream HTML 403 interstitial can recover, but plain 403 still stops", async () => {
  const retry=fixture({statusSequence:[403,200],responseHeaders:{"content-type":"text/html"}});
  assert.equal((await retry.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"})).sessionId,saved);
  assert.deepEqual(retry.urls,[saved,saved]);
  assert.equal(retry.sends(),1);
  const denied=fixture({status:403,responseHeaders:{"content-type":"application/json"}});
  await assert.rejects(denied.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"}),/authentication\/access/);
  assert.deepEqual(denied.urls,[saved]);
  assert.equal(denied.sends(),0);
});
test("backend HTML 403 recovery never resends after a recoverable first pre-send failure", async () => {
  const f=fixture({backendDenied:true,backendDeniedCount:1});
  const output=await f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"});
  assert.equal(output.sessionId,saved);
  assert.deepEqual(f.urls,[saved,saved]);
  assert.equal(f.sends(),1);
});
test("interactive verification waits for the owner in the existing tab", async () => {
  const f=fixture({body:"Verify you are human — CAPTCHA"});
  await assert.rejects(f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"}),/interactive_verification/);
  assert.deepEqual(f.urls,[saved]);
  assert.equal(f.closes(),0);
  assert.equal(f.sends(),0);
});
test("rate limits never trigger automated browser retries or message resubmission", async () => {
  const f=fixture({status:429});
  await assert.rejects(f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"}),/provider_denial/);
  assert.deepEqual(f.urls,[saved]);
  assert.equal(f.sends(),0);
});

test("Cloudflare HTML 403 with human verification is left visible and not reloaded", async () => {
  const f=fixture({status:403,responseHeaders:{"content-type":"text/html"},
    body:"Verify you are human — CAPTCHA"});
  await assert.rejects(f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"}),/interactive_verification/);
  assert.deepEqual(f.urls,[saved]);
  assert.equal(f.closes(),0);
  assert.equal(f.sends(),0);
});
test("an earlier backend challenge cannot hide a human verification screen", async () => {
  const f=fixture({backendDenied:true,body:"Verify you are human — CAPTCHA"});
  await assert.rejects(f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"}),/interactive_verification/);
  assert.deepEqual(f.urls,[saved]);
  assert.equal(f.sends(),0);
});
test("HTML 401 remains a hard login refusal and never gets a challenge retry", async () => {
  const f=fixture({status:401,responseHeaders:{"content-type":"text/html"}});
  await assert.rejects(f.executor.run({projectRoot:"/project",sessionId:saved,prompt:"Work"}),/authentication\/access/);
  assert.deepEqual(f.urls,[saved]);
  assert.equal(f.sends(),0);
});
