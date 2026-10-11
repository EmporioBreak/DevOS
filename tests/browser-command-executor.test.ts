import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { BrowserCommandBroker } from "../src/browser-command-broker.js";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";

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
    await assert.rejects(executor.run({
      projectRoot: root, prompt, workerId: "developer", browserTurnId: commandId,
      reportTurn: { task: { repo: "EmporioBreak/DevOS", issue: 239, pr: 241 }, active: { workerId: "developer", turn: 1, tokenHash: "a".repeat(64) } },
      browserCommand: {
        task: { repo: "EmporioBreak/DevOS", issue: 239, pr: 240 },
        workerId: "developer", turn: 1, commandId,
      },
    } as any), /Trusted browser command identity/);
    assert.equal(sends, 0, "missing trusted report turn must be rejected before native Send");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
