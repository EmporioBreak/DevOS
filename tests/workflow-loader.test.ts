import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflow } from "../src/workflow-loader.js";

test("parses needs_local_worker routes in a valid workflow", () => {
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
          on: { done: "reviewer", needs_local_worker: "host", failed: null },
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
          on: { done: "reviewer", needs_local_worker: "host", failed: null },
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

test("parses main_agent as the task owner", () => {
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
    parseWorkflow({ ...base, owner: { mode: "main_agent" } }).owner,
    { mode: "main_agent" },
  );
});

test("rejects legacy owner modes with a migration hint", () => {
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
  assert.throws(
    () => parseWorkflow({ ...base, owner: { mode: "chatgpt_conversation", conversationUrl: "https://chatgpt.com/c/main-task" } }),
    /unsupported mode: chatgpt_conversation.*main_agent/,
  );
  assert.throws(
    () => parseWorkflow({ ...base, owner: { mode: "parent_process" } }),
    /unsupported mode: parent_process.*main_agent/,
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
            on: { done: null, needs_local_worker: "local_developer" },
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
