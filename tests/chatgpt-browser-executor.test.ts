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
