import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { BrowserCommandBroker } from "../src/browser-command-broker.js";
import { BrowserPreSubmitFailureError, ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";

test("browser executor commits a signed task command claim before Send and ACKs the provider receipt", async () => {
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
      claimStatusAtSend = (await broker.get(commandId))?.status;
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
    undefined, broker,
  );
  Object.assign(executor, { context: {
    async newPage() { return page; },
    pages() { return [page]; },
    async addInitScript() {},
    async close() {},
    on() {},
  } });
  try {
    const result = await executor.run({
      projectRoot: root, prompt, workerId: "developer", browserTurnId: commandId,
      browserCommand: {
        task: { repo: "EmporioBreak/DevOS", issue: 239 },
        workerId: "developer", turn: 1, commandId,
      },
    } as any);
    assert.equal(result.sessionId, conversationUrl);
    assert.equal(sends, 1);
    assert.equal(claimStatusAtSend, "claimed", "Send must follow the durable claim");
    const record = await broker.get(commandId);
    assert.equal(record?.status, "acknowledged");
    assert.equal(record?.receipt?.messageId, "user-message-1");
    assert.equal(record?.receipt?.conversationId, "conversation-1");
    await assert.rejects(executor.run({
      projectRoot: root, prompt, workerId: "developer", browserTurnId: commandId,
      browserCommand: {
        task: { repo: "EmporioBreak/DevOS", issue: 239 },
        workerId: "developer", turn: 1, commandId,
      },
    } as any), error => error instanceof Error && !(error instanceof BrowserPreSubmitFailureError));
    assert.equal(sends, 1, "a claimed command cannot become a safe-to-retry pre-submit failure");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
