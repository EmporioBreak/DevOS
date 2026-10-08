import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import { captureProcessIdentity } from "../src/process-identity.js";
import { ChatWorkerProbeRegistry } from "../src/chat-worker-probe.js";
import { ChatWorkerGrantRegistry } from "../src/chat-worker-grants.js";
import { observeWorkerAuthorization } from "../src/chat-worker-observer.js";

const repo = "EmporioBreak/DevOS";
const task = { repo, issue: 99 };
const url = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/c/6ac7d917-1390-83ed-95a7-e6309a53e812";
const resource = "/asdk_app_pinned/link_pinned/devos_worker_probe";
const prompt = "DEVOS worker authorizing precise turn; token=" + "3".repeat(64);
const secret = randomBytes(32).toString("hex");
const fp = "chat_" + "d".repeat(64);

async function temp() {
  const root = await mkdtemp(join(tmpdir(), "devos-exact-page-test-"));
  const statePath = join(root, ".devos", "state", "EmporioBreak%2FDevOS-issue-99.json");
  const resourcePath = join(root, ".devos", "connector", "worker-probe-resource-uri");
  await mkdir(dirname(statePath), { recursive: true });
  await mkdir(dirname(resourcePath), { recursive: true });
  await writeFile(join(root, ".env"), "DEVOS_CONNECTOR_OWNER_SECRET=" + secret + "\n", { mode: 0o600 });
  await writeFile(resourcePath, resource + "\n", { mode: 0o600 });
  await writeFile(statePath, JSON.stringify({
    currentWorkerId: "developer", completedRuns: 1,
    activeReport: { workerId: "developer", turn: 1 },
    sessions: { developer: url },
  }));
  const lockPath=join(root,".devos","locks","EmporioBreak%2FDevOS-issue-99.lock");
  await mkdir(dirname(lockPath),{recursive:true,mode:0o700});
  const identity=await captureProcessIdentity(process.pid);
  assert.ok(identity);
  await writeFile(lockPath,JSON.stringify({repo:task.repo,issue:task.issue,pid:process.pid,
    identity,runId:"test-active-task",startedAt:new Date().toISOString()}),{mode:0o600});
  const probe = new ChatWorkerProbeRegistry(root, secret);
  const issued = probe.issue(fp, Date.now());
  assert.equal(issued.status, "issued");
  if (issued.status !== "issued") throw Error("missing probe");
  return { root, nonce: issued.nonce };
}
function providerHistory(nonce: string, originUrl = url) {
  const cid = /\/c\/([^/]+)$/.exec(originUrl)?.[1];
  return { conversation_id: cid, messages: [
    { id: "user-1", author: { role: "user" }, content: { content_type: "text", parts: [prompt] } },
    { id: "tool-1", author: { role: "tool", name: "api_tool.call_tool" },
      status: "finished_successfully", metadata: { invoked_resource: { resource_uri: resource } },
      content: { content_type: "code", text: JSON.stringify({ status: "issued", nonce }) } },
  ] };
}
function browserFake(history: unknown, exactUrl = url) {
  let pagesCreated = 0;
  let closed = false;
  const verifier = {
    url: () => exactUrl,
    waitForResponse: () => Promise.resolve({
      url: () => "https://chatgpt.com/backend-api/conversations/" + exactUrl.split("/c/")[1],
      status: () => 200,
      json: async () => history,
    }),
    goto: async () => ({ status: () => 200 }),
    close: async () => { closed = true; },
  };
  const page = {
    url: () => exactUrl,
    context: () => ({ newPage: async () => { pagesCreated++; return verifier; } }),
    bringToFront: async () => undefined,
  } as unknown as Page;
  return { page, get stats() { return { pagesCreated, closed }; } };
}
test("browser observer authorizes only a probe observed in the exact worker conversation", async () => {
  const { root, nonce } = await temp();
  try {
    const browser = browserFake(providerHistory(nonce));
    const abort = new AbortController();
    const result = await observeWorkerAuthorization({
      page: browser.page, root, task, workerId: "developer", turn: 1,
      expectedConversation: () => url,
      exactSubmittedPrompt: prompt, signal: abort.signal,
    });
    assert.equal(result, true);
    assert.deepEqual(browser.stats, { pagesCreated: 1, closed: true });
    assert.equal(new ChatWorkerGrantRegistry(root, secret).isGranted(fp), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("browser observer never touches a URL different from the predeclared worker chat", async () => {
  const { root, nonce } = await temp();
  try {
    const browser = browserFake(providerHistory(nonce), url.replace(/\d$/, "4"));
    const abort = new AbortController();
    abort.abort();
    const result = await observeWorkerAuthorization({
      page: browser.page, root, task, workerId: "developer", turn: 1,
      expectedConversation: () => url,
      exactSubmittedPrompt: prompt, signal: abort.signal,
    });
    assert.equal(result, false);
    assert.equal(browser.stats.pagesCreated, 0);
    assert.equal(new ChatWorkerGrantRegistry(root, secret).isGranted(fp), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
