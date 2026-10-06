import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { isSameChatGptConversation, waitForConversationUrl } from "../src/chatgpt-browser-executor.js";

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
  const page = { url: () => currentUrl } as unknown as Page;
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
  const page = { url: () => url, async goto() { url = navigation; }, locator: () => locator, async evaluate() { return { text: 'DEVOS_RESULT {"status":"done"}', failed: false }; }, async waitForFunction() {}, async close() {} };
  const executor = new ChatGptBrowserExecutor({ projectUrl, profileDir: "/unused", browserChannel: "chrome", headless: false }, 50);
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
    url: () => url, async goto() {}, locator: () => locator,
    async evaluate() { return 1; }, async waitForFunction() { throw new Error("response failed after submission"); }, async close() {},
  };
  const executor = new ChatGptBrowserExecutor({ projectUrl: project, profileDir: "/unused", browserChannel: "chrome", headless: false }, 1000);
  Object.assign(executor, { context: { async newPage() { return page; } } });
  await assert.rejects(executor.run({ projectRoot: "/project", prompt: "Work", enforceProjectScope: true, onSession: id => { saved = id; } }), /response failed after submission/);
  assert.equal(saved, created);
});
