/** Opt-in real Camoufox test: npx tsx tests/shared-browser-windows.smoke.ts */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { profileProcesses } from "../src/owned-browser-process.js";
import { browserRuntimePaths, closeSharedBrowserRuntime, startSharedBrowserServer } from "../src/shared-browser-runtime.js";
import type { TaskRef } from "../src/workflow.js";

const root = await mkdtemp(join(tmpdir(), "devos-camoufox-task-windows-"));
const profileDir = join(root, "new-empty-profile");
const taskA: TaskRef = { repo: "smoke/DevOS", issue: 22601 };
const taskB: TaskRef = { repo: "smoke/DevOS", issue: 22602 };
const paths = browserRuntimePaths(root, taskA.repo, taskA.issue);
const executor = new ChatGptBrowserExecutor({
  projectUrl: "https://chatgpt.com/g/smoke/project",
  profileDir,
  headless: false,
}, 10_000,
async browserRoot => {
  const existing = JSON.parse(await readFile(paths.metadata, "utf8"));
  const temp = paths.metadata + ".update";
  await writeFile(temp, JSON.stringify({ ...existing, browserRoot, profileDir }), { mode: 0o600 });
  await rename(temp, paths.metadata);
}, async (task, marker) => {
  const existing = JSON.parse(await readFile(paths.metadata, "utf8"));
  const taskWindows = { ...(existing.taskWindows ?? {}) } as Record<string, string>;
  const key = `${task.repo}#${task.issue}`;
  if (marker) taskWindows[key] = marker;
  else delete taskWindows[key];
  const temp = paths.metadata + ".update";
  await writeFile(temp, JSON.stringify({ ...existing, taskWindows }), { mode: 0o600 });
  await rename(temp, paths.metadata);
});

const live = (executor as unknown as {
  getContext(timeout: number): Promise<BrowserContext>;
  getWorkerPage(request: { task: TaskRef; workerId: string }, context: BrowserContext): Promise<Page>;
});
try {
  await startSharedBrowserServer(paths.socket, paths.metadata, executor);
  const context = await live.getContext(20_000);
  const [aDeveloper, aReviewer] = await Promise.all([
    live.getWorkerPage({ task: taskA, workerId: "developer" }, context),
    live.getWorkerPage({ task: taskA, workerId: "reviewer" }, context),
  ]);
  const [bDeveloper, bReviewer] = await Promise.all([
    live.getWorkerPage({ task: taskB, workerId: "developer" }, context),
    live.getWorkerPage({ task: taskB, workerId: "reviewer" }, context),
  ]);
  await Promise.all([
    aDeveloper.goto("data:text/html,<title>Issue A developer</title>", { waitUntil: "domcontentloaded" }),
    aReviewer.goto("data:text/html,<title>Issue A reviewer</title>", { waitUntil: "domcontentloaded" }),
    bDeveloper.goto("data:text/html,<title>Issue B developer</title>", { waitUntil: "domcontentloaded" }),
    bReviewer.goto("data:text/html,<title>Issue B reviewer</title>", { waitUntil: "domcontentloaded" }),
  ]);
  assert.equal(new Set([aDeveloper.context(), aReviewer.context(), bDeveloper.context(), bReviewer.context()]).size, 1,
    "all four pages must belong to one real Camoufox context");
  const livePages = context.pages().filter(page => !page.isClosed());
  const [aMarker, aSiblingMarker, bMarker, bSiblingMarker] = await Promise.all([
    aDeveloper.evaluate(() => window.name), aReviewer.evaluate(() => window.name),
    bDeveloper.evaluate(() => window.name), bReviewer.evaluate(() => window.name),
  ]);
  assert.equal(aMarker, aSiblingMarker, "Issue A worker pages share its task window marker");
  assert.equal(bMarker, bSiblingMarker, "Issue B worker pages share its task window marker");
  assert.notEqual(aMarker, bMarker, "Issue windows have distinct persisted ownership markers");
  const ownedPages = await Promise.all(livePages.map(async page => page.evaluate(() => window.name)));
  assert.equal(ownedPages.filter(marker => marker === aMarker || marker === bMarker).length, 4,
    "two task windows each own two actual worker pages; the runtime's initial blank page stays unclaimed");
  const roots = await profileProcesses(profileDir);
  assert.equal(roots.length, 1, "both tasks run under one persistent Camoufox process");
  const owner = JSON.parse(await readFile(paths.metadata, "utf8"));
  assert.equal(owner.browserRoot.pid, roots[0]!.pid, "runtime records the exact Camoufox root PID");
  assert.equal(owner.browserRoot.identity, roots[0]!.identity, "runtime records the exact Camoufox process identity");
  assert.deepEqual(Object.keys(owner.taskWindows).sort(), [`${taskA.repo}#${taskA.issue}`, `${taskB.repo}#${taskB.issue}`].sort());

  await closeSharedBrowserRuntime(root, taskA);
  assert.equal((await profileProcesses(profileDir))[0]?.pid, roots[0]!.pid,
    "closing Issue A keeps the same Camoufox process alive for Issue B");
  assert.equal(aDeveloper.isClosed(), true);
  assert.equal(aReviewer.isClosed(), true);
  assert.equal(await bDeveloper.evaluate(() => 6 * 7), 42, "Issue B still executes in the same live browser");
  assert.deepEqual(Object.keys(JSON.parse(await readFile(paths.metadata, "utf8")).taskWindows), [`${taskB.repo}#${taskB.issue}`]);

  await closeSharedBrowserRuntime(root, taskB);
  assert.equal((await profileProcesses(profileDir)).length, 0,
    "the exact owned Camoufox process exits after the last task window closes");
  console.log(JSON.stringify({
    camoufox: "real",
    profile: "new empty test profile; no credentials copied",
    taskWindows: 2,
    taskTabs: 2,
    sharedProcess: roots[0]!.pid,
    scopedClose: true,
    exactOwnership: true,
  }));
} finally {
  await closeSharedBrowserRuntime(root, taskA).catch(() => undefined);
  await closeSharedBrowserRuntime(root, taskB).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
