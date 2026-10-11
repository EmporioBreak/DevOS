import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "playwright-core";
import { BrowserCommandBroker } from "../src/browser-command-broker.js";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { signBrowserCommandAuthorization } from "../src/browser-command-identity.js";
import { reportTokenHash } from "../src/mcp-tools/registry.js";

test("browser executor refuses a native Send without the active trusted report turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-executor-"));
  const projectUrl = "https://chatgpt.com/g/project/project";
  const conversationUrl = "https://chatgpt.com/g/project/c/conversation-1";
  const commandId = "cmd-239-worker-turn-1";
  const broker = new BrowserCommandBroker(root);
  const listeners = new Map<string, Array<(value: any) => void>>();
  let url = projectUrl;
  let sends = 0;
  let claimStatusAtSend: string | undefined;
  const prompt = "Run the approved worker task";
  const outgoing = {
    url: () => "https://chatgpt.com/backend-api/conversation",
    method: () => "POST",
    postDataJSON: () => ({
      conversation_id: "conversation-1",
      messages: [{ id: "user-message-1", author: { role: "user" }, content: { parts: [prompt] } }],
    }),
  };
  const response = { request: () => outgoing, status: () => 200, url: () => outgoing.url() };
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const locator = {
    first() { return this; },
    async waitFor() {},
    async fill() {},
    async isVisible() { return true; },
    async click() {
      sends++;
      url = conversationUrl;
      emit("request", outgoing);
      emit("response", response);
    },
    async press() { throw new Error("fixture expects the visible Send button"); },
  };
  const frame = {};
  const page = {
    on(event: string, listener: (value: any) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off(event: string, listener: (value: any) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter(existing => existing !== listener));
    },
    mainFrame: () => frame,
    url: () => url,
    async goto() { url = projectUrl; return { status: () => 200 }; },
    locator: () => locator,
    async evaluate(fn: Function) {
      return fn.toString().includes("__DEVOS_ARM_STREAM__") ? 1 : { text: "done", failed: false };
    },
    async waitForFunction() {},
    async close() {},
    isClosed: () => false,
  } as unknown as Page;
  const executor = new ChatGptBrowserExecutor(
    { projectUrl, profileDir: join(root, "profile"), headless: true }, 1000,
    undefined, undefined, undefined, broker,
  );
  Object.assign(executor, { context: {
    async newPage() { return page; },
    pages() { return [page]; },
    async addInitScript() {},
    async close() {},
    on() {},
  } });
  try {
    await assert.rejects(executor.run({
      projectRoot: root, prompt, workerId: "developer", browserTurnId: commandId,
      reportTurn: { task: { repo: "EmporioBreak/DevOS", issue: 239, pr: 241 }, active: { workerId: "developer", turn: 1, tokenHash: "a".repeat(64) } },
      browserCommand: {
        task: { repo: "EmporioBreak/DevOS", issue: 239, pr: 240 },
        workerId: "developer", turn: 1, commandId, reportTokenHash: "a".repeat(64),
        graphSha256: "b".repeat(64), workerManifestSha256: "c".repeat(64), authorizationMac: "d".repeat(64),
      },
    } as any), /Trusted browser command identity/);
    assert.equal(sends, 0, "missing trusted report turn must be rejected before native Send");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser executor claims the signed Issue window before Send and ACKs the exact provider receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-executor-green-"));
  const ownerSecret = "test-owner-secret-that-is-at-least-thirty-two-bytes";
  const task = { repo: "EmporioBreak/DevOS", issue: 239, pr: 240 };
  const token = "a".repeat(64), tokenHash = reportTokenHash(token);
  const commandId = `239:0:developer:${tokenHash}`;
  const graphSha256 = "b".repeat(64), workerManifestSha256 = "c".repeat(64);
  const authorization = { repo: task.repo, issue: task.issue, pr: task.pr, workerId: "developer", turn: 0,
    commandId, reportTokenHash: tokenHash, graphSha256, workerManifestSha256 };
  const broker = new BrowserCommandBroker(root, ownerSecret);
  const listeners = new Map<string, Array<(value: any) => void>>();
  const projectUrl = "https://chatgpt.com/g/project/project";
  const conversationUrl = "https://chatgpt.com/g/project/c/conversation-1";
  const prompt = "Run the approved worker task";
  let url = projectUrl, sends = 0, statusAtSend: string | undefined;
  const outgoing = { url: () => "https://chatgpt.com/backend-api/conversation", method: () => "POST",
    postDataJSON: () => ({ conversation_id: "conversation-1", messages: [{ id: "user-message-1", author: { role: "user" }, content: { parts: [prompt] } }] }) };
  const response = { request: () => outgoing, status: () => 200, url: () => outgoing.url() };
  const emit = (event: string, value: unknown) => { for (const listener of listeners.get(event) ?? []) listener(value); };
  const locator = { first() { return this; }, async waitFor() {}, async fill() {}, async isVisible() { return true; },
    async click() { statusAtSend = (await broker.get(commandId))?.status; sends++; url = conversationUrl; emit("request", outgoing); emit("response", response); },
    async press() { throw new Error("fixture expects the visible Send button"); } };
  const marker = `devos-task-window:${createHash("sha256").update(`${task.repo}#${task.issue}`).digest("hex")}`;
  const frame = {};
  const page = { on(event: string, listener: (value: any) => void) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    off(event: string, listener: (value: any) => void) { listeners.set(event, (listeners.get(event) ?? []).filter(x => x !== listener)); },
    mainFrame: () => frame, url: () => url, async goto() { url = projectUrl; return { status: () => 200 }; }, locator: () => locator,
    async evaluate(fn: Function) { const source=fn.toString(); if(source.includes("window.name")) return marker; return source.includes("__DEVOS_ARM_STREAM__") ? 1 : { text: "done", failed: false }; },
    async waitForFunction() {}, async close() {}, isClosed: () => false } as unknown as Page;
  const executor = new ChatGptBrowserExecutor({ projectUrl, profileDir: join(root, "profile"), headless: true }, 1000,
    undefined, undefined, undefined, broker);
  Object.assign(executor, { context: { async newPage() { return page; }, pages() { return [page]; }, async addInitScript() {}, async close() {}, on() {} },
    workerPages: new Map([[`${task.repo}#${task.issue}\0developer`, page]]), taskWindowPages: new Map([[`${task.repo}#${task.issue}`, page]]) });
  const active = { workerId: "developer", turn: 0, tokenHash };
  const reportPath = join(root, ".devos", "worker-reports", `${encodeURIComponent(task.repo)}-issue-${task.issue}`, `turn-0-${tokenHash}.json`);
  await mkdir(join(root, ".devos", "worker-reports", `${encodeURIComponent(task.repo)}-issue-${task.issue}`), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ task: { repo: task.repo, issue: task.issue }, worker_id: "developer", turn: 0,
    token_hash: tokenHash, status: "done", summary: "fixture report" }));
  try {
    const result = await executor.run({ projectRoot: root, task, prompt, workerId: "developer", browserTurnId: commandId,
      reportTurn: { task, active }, browserCommand: { task, workerId: "developer", turn: 0, commandId, reportTokenHash: tokenHash,
        graphSha256, workerManifestSha256, authorizationMac: signBrowserCommandAuthorization(authorization, ownerSecret) } } as any);
    assert.equal(result.sessionId, conversationUrl);
    assert.equal(sends, 1);
    assert.equal(statusAtSend, "claimed", "the durable single-project window claim must precede native Send");
    const record = await broker.get(commandId);
    assert.equal(record?.status, "acknowledged");
    assert.equal(record?.receipt?.messageId, "user-message-1");
    assert.equal(record?.command.graphSha256, graphSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
