import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchKey,
  parseIssueDispatch,
  runDispatchCycle,
  type DispatchSource,
  type DispatchStatus,
  type DispatchStore,
  type IssueSummary,
} from "../src/github-dispatch.js";

const workflow = {
  version: 1,
  task: { repo: "owner/product", issue: 42 },
  start: "developer",
  workers: [
    {
      id: "developer",
      executor: "chatgpt_browser",
      prompt: "Implement.",
      on: { done: "reviewer", needs_host: "local_developer" },
    },
    {
      id: "local_developer",
      executor: "codex",
      prompt: "Continue on host.",
      on: { done: "reviewer" },
    },
    {
      id: "reviewer",
      executor: "chatgpt_browser",
      prompt: "Review.",
      on: { approved: null, changes_requested: "developer" },
    },
  ],
};

function body(mode: "run" | "restart" = "run"): string {
  return [
    "# Task",
    "",
    "<!-- DEVOS_DISPATCH_V1 -->",
    "```json",
    JSON.stringify({ version: 1, id: "homepage-r1", mode, workflow }, null, 2),
    "```",
  ].join("\n");
}

class MemorySource implements DispatchSource {
  constructor(private readonly issues: IssueSummary[]) {}
  async listOpenIssues(): Promise<IssueSummary[]> { return [...this.issues]; }
}

class MemoryStore implements DispatchStore {
  readonly values = new Map<string, DispatchStatus>();
  async get(key: string): Promise<DispatchStatus | undefined> {
    return this.values.get(key);
  }
  async set(key: string, status: DispatchStatus): Promise<void> {
    this.values.set(key, status);
  }
}

test("parses a workflow dispatch from its matching issue", () => {
  const dispatch = parseIssueDispatch(body(), "owner/product", 42);
  assert.equal(dispatch?.id, "homepage-r1");
  assert.equal(dispatch?.workflow.task.issue, 42);
  assert.equal(dispatch?.workflow.workers[0]?.id, "developer");
});

test("rejects a dispatch whose workflow points at another issue", () => {
  assert.throws(
    () => parseIssueDispatch(body(), "owner/product", 41),
    /does not match its GitHub issue/,
  );
});

test("runs a new dispatch once and marks it completed", async () => {
  const store = new MemoryStore();
  const modes: string[] = [];
  const result = await runDispatchCycle({
    repo: "owner/product",
    cwd: "/project",
    source: new MemorySource([{ number: 42, body: body() }]),
    store,
    execute: async (_dispatch, mode) => { modes.push(mode); },
  });

  assert.equal(result?.status, "completed");
  assert.deepEqual(modes, ["run"]);
  assert.equal(
    store.values.get(dispatchKey("owner/product", parseIssueDispatch(body(), "owner/product", 42)!)),
    "completed",
  );
});

test("resumes a started restart dispatch without clearing state again", async () => {
  const store = new MemoryStore();
  const dispatch = parseIssueDispatch(body("restart"), "owner/product", 42)!;
  await store.set(dispatchKey("owner/product", dispatch), "started");

  const modes: string[] = [];
  await runDispatchCycle({
    repo: "owner/product",
    cwd: "/project",
    source: new MemorySource([{ number: 42, body: body("restart") }]),
    store,
    execute: async (_dispatch, mode) => { modes.push(mode); },
  });

  assert.deepEqual(modes, ["run"]);
});

test("marks a failed dispatch blocked instead of retrying it forever", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const source = new MemorySource([{ number: 42, body: body() }]);

  const first = await runDispatchCycle({
    repo: "owner/product",
    cwd: "/project",
    source,
    store,
    execute: async () => {
      attempts += 1;
      throw new Error("worker failed");
    },
  });
  const second = await runDispatchCycle({
    repo: "owner/product",
    cwd: "/project",
    source,
    store,
    execute: async () => { attempts += 1; },
  });

  assert.equal(first?.status, "blocked");
  assert.equal(first?.error, "worker failed");
  assert.equal(second, null);
  assert.equal(attempts, 1);
});
