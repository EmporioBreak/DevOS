import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflow } from "../src/workflow-loader.js";

test("parses needs_host routes in a valid workflow", () => {
  assert.deepEqual(
    parseWorkflow({
      version: 1,
      task: { repo: "owner/product", issue: 7, pr: 8 },
      start: "developer",
      workers: [
        {
          id: "developer",
          executor: "chatgpt_browser",
          prompt: "Attempt the task.",
          on: { done: "reviewer", needs_host: "host", failed: null },
        },
        {
          id: "host",
          executor: "codex",
          prompt: "Continue on the host.",
          on: { done: "reviewer", failed: null },
        },
        {
          id: "reviewer",
          executor: "chatgpt_browser",
          prompt: "Review the implementation.",
          on: { approved: null, changes_requested: "developer" },
        },
      ],
    }),
    {
      version: 1,
      task: { repo: "owner/product", issue: 7, pr: 8 },
      start: "developer",
      workers: [
        {
          id: "developer",
          executor: "chatgpt_browser",
          prompt: "Attempt the task.",
          on: { done: "reviewer", needs_host: "host", failed: null },
        },
        {
          id: "host",
          executor: "codex",
          prompt: "Continue on the host.",
          on: { done: "reviewer", failed: null },
        },
        {
          id: "reviewer",
          executor: "chatgpt_browser",
          prompt: "Review the implementation.",
          on: { approved: null, changes_requested: "developer" },
        },
      ],
    },
  );
});

test("parses both task owner modes", () => {
  const base = {
    version: 1,
    task: { repo: "owner/product", issue: 7 },
    start: "developer",
    workers: [
      {
        id: "developer",
        executor: "chatgpt_browser",
        prompt: "Implement.",
        on: { done: null },
      },
    ],
  };

  assert.deepEqual(
    parseWorkflow({
      ...base,
      owner: {
        mode: "chatgpt_conversation",
        conversationUrl: "https://chatgpt.com/c/main-task",
      },
    }).owner,
    {
      mode: "chatgpt_conversation",
      conversationUrl: "https://chatgpt.com/c/main-task",
    },
  );

  assert.deepEqual(
    parseWorkflow({ ...base, owner: { mode: "parent_process" } }).owner,
    { mode: "parent_process" },
  );
});

test("rejects a ChatGPT owner URL that is not a conversation", () => {
  assert.throws(
    () =>
      parseWorkflow({
        version: 1,
        task: { repo: "owner/product", issue: 7 },
        owner: {
          mode: "chatgpt_conversation",
          conversationUrl: "https://chatgpt.com/",
        },
        start: "developer",
        workers: [
          {
            id: "developer",
            executor: "chatgpt_browser",
            prompt: "Implement.",
            on: { done: null },
          },
        ],
      }),
    /must identify a ChatGPT conversation/,
  );
});

test("rejects unknown workers in routes", () => {
  assert.throws(
    () =>
      parseWorkflow({
        version: 1,
        task: { repo: "owner/product", issue: 7 },
        start: "developer",
        workers: [
          {
            id: "developer",
            executor: "codex",
            prompt: "Implement.",
            on: { done: "missing" },
          },
        ],
      }),
    /routes to unknown worker: missing/,
  );
});

test("rejects unsupported executors", () => {
  assert.throws(
    () =>
      parseWorkflow({
        version: 1,
        task: { repo: "owner/product", issue: 7 },
        start: "developer",
        workers: [
          {
            id: "developer",
            executor: "unknown",
            prompt: "Implement.",
            on: { done: null },
          },
        ],
      }),
    /unsupported executor/,
  );
});

test("rejects undeclared host fallback workers", () => {
  assert.throws(
    () =>
      parseWorkflow({
        version: 1,
        task: { repo: "owner/product", issue: 18 },
        start: "developer",
        workers: [
          {
            id: "developer",
            executor: "chatgpt_browser",
            prompt: "Attempt the task.",
            on: { done: null, needs_host: "local_developer" },
          },
        ],
      }),
    /routes to unknown worker: local_developer/,
  );
});

test("rejects non-null failed routes", () => {
  assert.throws(
    () =>
      parseWorkflow({
        version: 1,
        task: { repo: "owner/product", issue: 26 },
        start: "developer",
        workers: [
          {
            id: "developer",
            executor: "chatgpt_browser",
            prompt: "Attempt the task.",
            on: { done: null, failed: "recovery" },
          },
          {
            id: "recovery",
            executor: "codex",
            prompt: "Recover.",
            on: { done: null },
          },
        ],
      }),
    /cannot route failed status/,
  );
});
