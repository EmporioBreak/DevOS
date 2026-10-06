import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore } from "../src/json-state-store.js";

test("isolates state by GitHub task", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const first = new JsonStateStore(root, { repo: "owner/product", issue: 41 });
    const second = new JsonStateStore(root, { repo: "owner/product", issue: 42 });

    assert.notEqual(first.path, second.path);
    assert.equal(await first.load(), null);
    assert.equal(await second.load(), null);

    await first.save({
      currentWorkerId: "reviewer",
      completedRuns: 3,
      sessions: { reviewer: "session-one" },
    });

    assert.deepEqual(await first.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 3,
      sessions: { reviewer: "session-one" },
    });
    assert.equal(await second.load(), null);

    const raw = await readFile(first.path, "utf8");
    assert.match(raw, /"session-one"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear removes only the active task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const first = new JsonStateStore(root, { repo: "owner/product", issue: 41 });
    const second = new JsonStateStore(root, { repo: "owner/product", issue: 42 });

    await first.save({
      currentWorkerId: "worker",
      completedRuns: 1,
      sessions: {},
    });
    await second.save({
      currentWorkerId: "worker",
      completedRuns: 2,
      sessions: {},
    });

    await first.clear();

    assert.equal(await first.load(), null);
    assert.deepEqual(await second.load(), {
      currentWorkerId: "worker",
      completedRuns: 2,
      sessions: {},
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("persists a PR resolved during task execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const store = new JsonStateStore(root, { repo: "owner/product", issue: 39 });
    await store.save({
      currentWorkerId: "reviewer",
      completedRuns: 2,
      sessions: {
        developer: "https://chatgpt.com/c/dev",
        reviewer: "https://chatgpt.com/c/review",
      },
      task: { repo: "owner/product", issue: 39, pr: 40 },
      ownerReviewPending: true,
    });

    assert.deepEqual(await store.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 2,
      sessions: {
        developer: "https://chatgpt.com/c/dev",
        reviewer: "https://chatgpt.com/c/review",
      },
      task: { repo: "owner/product", issue: 39, pr: 40 },
      ownerReviewPending: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("persists browser worker start markers with task-local sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const store = new JsonStateStore(root, { repo: "owner/product", issue: 44 });
    await store.save({
      currentWorkerId: "developer",
      completedRuns: 1,
      sessions: { developer: "https://chatgpt.com/g/g-p-project/c/dev" },
      browserWorkersStarted: ["developer"],
      task: { repo: "owner/product", issue: 44 },
    });

    assert.deepEqual(await store.load(), {
      currentWorkerId: "developer",
      completedRuns: 1,
      sessions: { developer: "https://chatgpt.com/g/g-p-project/c/dev" },
      browserWorkersStarted: ["developer"],
      task: { repo: "owner/product", issue: 44 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists a pending one-worker browser recovery for the next invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));
  try {
    const store = new JsonStateStore(root, { repo: "owner/product", issue: 46 });
    const state = {
      currentWorkerId: "reviewer",
      completedRuns: 2,
      sessions: { developer: "https://chatgpt.com/g/g-p-project/c/developer" },
      browserWorkersStarted: ["developer", "reviewer"],
      browserSessionRecovery: ["reviewer"],
      task: { repo: "owner/product", issue: 46, pr: 50 },
    };
    await store.save(state);
    assert.deepEqual(await store.load(), state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
