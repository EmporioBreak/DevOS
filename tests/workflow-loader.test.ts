import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflow } from "../src/workflow-loader.js";

test("parses a minimal valid workflow", () => {
  assert.deepEqual(
    parseWorkflow({
      version: 1,
      task: { repo: "owner/product", issue: 7, pr: 8 },
      start: "developer",
      workers: [
        {
          id: "developer",
          executor: "codex",
          prompt: "Implement the task.",
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
          executor: "codex",
          prompt: "Implement the task.",
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
