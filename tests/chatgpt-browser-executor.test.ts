import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { isSameChatGptConversation, waitForConversationUrl, extractSubmittedTurn } from "../src/chatgpt-browser-executor.js";

test("recognizes only the saved Project conversation after browser resume", () => {
  const saved = "https://chatgpt.com/g/g-p-project/c/conversation-1";
  assert.equal(isSameChatGptConversation(saved, saved), true);
  assert.equal(
    isSameChatGptConversation(saved, "https://chatgpt.com/g/g-p-project/c/conversation-2"),
    false,
  );
  assert.equal(isSameChatGptConversation(saved, "https://chatgpt.com/g/g-p-project/project"), false);
  assert.equal(isSameChatGptConversation(saved, "https://chatgpt.com/c/conversation-1"), false);
});

test("waits for ChatGPT to replace its provisional conversation URL", async () => {
  let currentUrl = "https://chatgpt.com/g/g-p-project/project";
  const page = { on() {}, url: () => currentUrl } as unknown as Page;
  const provisionalUrl =
    "https://chatgpt.com/g/g-p-project/c/local-chatgpt%3A1234";
  const durableUrl =
    "https://chatgpt.com/g/g-p-project/c/6ac46626-a830-83ed-b43d-f10e683d9216";

  setTimeout(() => {
    currentUrl = provisionalUrl;
  }, 10);
  setTimeout(() => {
    currentUrl = durableUrl;
  }, 300);

  assert.equal(await waitForConversationUrl(page, 1000), durableUrl);
});

test("standalone saved conversation identity includes origin and exact route", () => {
  assert.equal(isSameChatGptConversation("https://chatgpt.com/c/saved", "https://chatgpt.com/c/saved?x=1"), true);
  assert.equal(isSameChatGptConversation("https://chatgpt.com/c/saved", "https://chatgpt.com/"), false);
  assert.equal(isSameChatGptConversation("https://chatgpt.com/c/saved", "https://chatgpt.com/g/other/c/saved"), false);
  assert.equal(isSameChatGptConversation("https://chatgpt.com/g/one/c/saved", "https://chatgpt.com/g/two/c/saved"), false);
});

import { ChatGptBrowserExecutor, BrowserResumeUnavailableError } from "../src/chatgpt-browser-executor.js";

function browserFixture(projectUrl: string, navigation: string, moveDuringFill?: string, moveAfterSend?: string) {
  let url = projectUrl;
  let sends = 0;
  const locator = { first() { return this; }, async waitFor() {}, async fill() { if (moveDuringFill) url = moveDuringFill; }, async isVisible() { return true; }, async click() { sends++; if (moveAfterSend) url = moveAfterSend; }, async press() { sends++; } };
  const page = { on() {}, url: () => url, async goto() { url = navigation; }, locator: () => locator, async evaluate() { return { text: 'DEVOS_RESULT {"status":"done"}', failed: false }; }, async waitForFunction() {}, async close() {} };
  const executor = new ChatGptBrowserExecutor({ projectUrl, profileDir: "/unused", headless: false }, 50);
  Object.assign(executor, { context: { async newPage() { return page; }, async close() {} } });
  return { executor, sends: () => sends };
}

test("standalone resume redirect is rejected before submission", async () => {
  const fixture = browserFixture("https://chatgpt.com/", "https://chatgpt.com/");
  await assert.rejects(fixture.executor.run({ projectRoot: "/project", prompt: "Work", sessionId: "https://chatgpt.com/c/saved", enforceProjectScope: true }), BrowserResumeUnavailableError);
  assert.equal(fixture.sends(), 0);
});

for (const resumed of [false, true]) {
  test(`navigation during composer preparation cannot submit ${resumed ? 'resumed' : 'fresh'} Project prompt`, async () => {
    const project = "https://chatgpt.com/g/one/project";
    const saved = "https://chatgpt.com/g/one/c/saved";
    const fixture = browserFixture(project, resumed ? saved : project, "https://chatgpt.com/c/outside");
    await assert.rejects(fixture.executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true, ...(resumed ? { sessionId: saved } : {}) }));
    assert.equal(fixture.sends(), 0);
  });
}

test("post-submit identity change fails without safe fresh replay classification", async () => {
  const saved = "https://chatgpt.com/c/saved";
  const fixture = browserFixture("https://chatgpt.com/", saved, undefined, "https://chatgpt.com/c/replacement");
  await assert.rejects(fixture.executor.run({ projectRoot: "/project", prompt: "Work", sessionId: saved }), error => error instanceof Error && !(error instanceof BrowserResumeUnavailableError));
  assert.equal(fixture.sends(), 1);
});


for (const destination of ["https://chatgpt.com/", "https://chatgpt.com/c/outside"]) {
  test(`resumed preparation navigation to ${destination} preserves safe recovery classification`, async () => {
    const project = "https://chatgpt.com/g/one/project";
    const saved = "https://chatgpt.com/g/one/c/saved";
    const fixture = browserFixture(project, saved, destination);
    await assert.rejects(
      fixture.executor.run({
        projectRoot: "/project",
        prompt: "Work",
        sessionId: saved,
        enforceProjectScope: true,
      }),
      error => error instanceof BrowserResumeUnavailableError,
    );
    assert.equal(fixture.sends(), 0);
  });
}

test("fresh response failure still persists a conversation created during submission", async () => {
  const project = "https://chatgpt.com/g/one/project";
  const created = "https://chatgpt.com/g/one/c/created";
  let url = project;
  let saved: string | undefined;
  const locator = {
    first() { return this; }, async waitFor() {}, async fill() {}, async isVisible() { return true; },
    async click() { url = created; }, async press() { url = created; },
  };
  const page = {
    on() {}, url: () => url, async goto() {}, locator: () => locator,
    async evaluate() { return 1; }, async waitForFunction() { throw new Error("response failed after submission"); }, async close() {},
  };
  const executor = new ChatGptBrowserExecutor({ projectUrl: project, profileDir: "/unused", headless: false }, 1000);
  Object.assign(executor, { context: { async newPage() { return page; }, async close() {} } });
  await assert.rejects(executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true, onSession: id => { saved = id; } }), /response failed after submission/);
  assert.equal(saved, created);
});

test("fresh URL discovery permits slow Project conversation creation beyond old 45-second gate", async () => {
  const project = "https://chatgpt.com/g/g-p-project/project";
  let url = project;
  const page = { url: () => url } as Page;
  const started = Date.now();
  setTimeout(() => { url = "https://chatgpt.com/g/g-p-project/c/created"; }, 600);
  assert.equal(await waitForConversationUrl(page, 180_000, project),
    "https://chatgpt.com/g/g-p-project/c/created");
  assert.ok(Date.now() - started >= 500);
});

test("URL discovery rejects cross-Project and standalone chats before resuming", async () => {
  for (const wrong of ["https://chatgpt.com/g/other/c/created", "https://chatgpt.com/c/created"]) {
    const page = { url: () => wrong } as Page;
    await assert.rejects(waitForConversationUrl(page, 500,
      "https://chatgpt.com/g/g-p-project/project"), /escaped the configured Project/);
  }
});

test("URL discovery never accepts a provisional ChatGPT conversation as durable", async () => {
  const page = { url: () => "https://chatgpt.com/g/g-p-project/c/local-chatgpt%3A123" } as Page;
  await assert.rejects(waitForConversationUrl(page, 20, "https://chatgpt.com/g/g-p-project/project"),
    /did not appear/);
});


test("request identity uses exactly one matching user across multiple envelope messages", () => {
  const messages = [
    { id: "tool", author: { role: "tool" }, content: { parts: ["different"] } },
    { id: "user1", author: { role: "user" }, content: { parts: ["the ", "prompt"] }, metadata: { request_id: "rid" } },
  ];
  assert.deepEqual(extractSubmittedTurn({ messages, conversation_id: "cid" }, "the prompt"), {
    messageId: "user1", conversationId: "cid", requestId: "rid",
  });
  assert.equal(extractSubmittedTurn({ messages: [messages[1], messages[1]] }, "the prompt"), null);
  assert.equal(extractSubmittedTurn({ messages: [{ ...messages[1], id: null }] }, "the prompt"), null);
  assert.equal(extractSubmittedTurn({ messages }, "other prompt"), null);
  assert.deepEqual(extractSubmittedTurn({ messages: [{ ...messages[1], content: { parts: [{ type: "text", text: "the prompt" }] } }] }, "the prompt"), { messageId: "user1", requestId: "rid" });
  assert.equal(extractSubmittedTurn({ messages: [{ ...messages[1], content: { parts: [{ type: "image", text: "the prompt" }] } }] }, "the prompt"), null);
  assert.equal(extractSubmittedTurn({ messages: [], headers: { token: "private" } }, "the prompt"), null);
});

test("same saved conversation recognizes canonicalized Project slug only for its immutable ID", () => {
  const saved = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/c/session";
  const canonical = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635/c/session";
  assert.equal(isSameChatGptConversation(saved, canonical), true);
  assert.equal(isSameChatGptConversation(saved,
    "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635/c/other"), false);
  assert.equal(isSameChatGptConversation(saved,
    "https://chatgpt.com/g/g-p-7aba984334d881918dea8eb28b1df635/c/session"), false);
});

test("resumed saved slugged Project chat accepts real slug-less canonical redirect before submit", async () => {
  const project = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/project";
  const requested = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/c/saved";
  const navigated = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635/c/saved";
  const fixture = browserFixture(project, navigated);
  const output = await fixture.executor.run({
    projectRoot: "/project", prompt: "Work", sessionId: requested, enforceProjectScope: true,
  });
  assert.equal(output.sessionId, requested);
  assert.equal(fixture.sends(), 1);
});


test("submitted turn tolerates only editor-equivalent line ending and trailing whitespace changes", () => {
  const msg = { id: "u-normalized", author: { role: "user" }, content: { parts: ["First line\r\nSecond line  \n"] } };
  assert.deepEqual(extractSubmittedTurn({ messages: [msg] }, "First line\nSecond line"), { messageId: "u-normalized" });
  assert.equal(extractSubmittedTurn({ messages: [msg] }, "First  line\nSecond line"), null);
  assert.equal(extractSubmittedTurn({ messages: [msg] }, "First line\nSecond lines"), null);
});

test("a unique per-turn correlation marker recovers a formatted request without accepting another turn", () => {
  const nonce = "a".repeat(64);
  const prompt = "Long original worker prompt with formatting.\n\nDevOS browser attempt ID: " + nonce + ". Correlate only this turn.";
  const user = { id: "u-proof", author: { role: "user" }, content: { parts: ["Reformatted user text with marker ", nonce] } };
  assert.deepEqual(extractSubmittedTurn({ messages: [user] }, prompt), { messageId: "u-proof" });
  assert.equal(extractSubmittedTurn({ messages: [{ ...user, content: { parts: ["marker ", "b".repeat(64)] } }] }, prompt), null);
  assert.equal(extractSubmittedTurn({ messages: [user, user] }, prompt), null);
});
