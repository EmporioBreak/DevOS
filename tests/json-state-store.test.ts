import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore, stateTemporaryPath } from "../src/json-state-store.js";

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
      mainAgentReviewPending: true,
    });

    assert.deepEqual(await store.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 2,
      sessions: {
        developer: "https://chatgpt.com/c/dev",
        reviewer: "https://chatgpt.com/c/review",
      },
      task: { repo: "owner/product", issue: 39, pr: 40 },
      mainAgentReviewPending: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads a saved legacy owner handoff as a main-agent handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const store = new JsonStateStore(root, { repo: "owner/product", issue: 42 });
    await mkdir(join(root, ".devos", "state"), { recursive: true });
    await writeFile(
      store.path,
      JSON.stringify({
        currentWorkerId: "reviewer",
        completedRuns: 1,
        sessions: { reviewer: "review-session" },
        ownerReviewPending: true,
      }),
    );

    assert.deepEqual(await store.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: { reviewer: "review-session" },
      mainAgentReviewPending: true,
    });
    await store.save((await store.load())!);
    assert.match(await readFile(store.path, "utf8"), /"mainAgentReviewPending": true/);
    assert.doesNotMatch(await readFile(store.path, "utf8"), /"ownerReviewPending"/);
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

test("validates approval and project-root fields, preserves legacy state migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));
  try {
    const store = new JsonStateStore(root, { repo: "owner/product", issue: 59 });
    const legacy = { currentWorkerId: "worker", completedRuns: 1, sessions: { worker: "thread" } };
    await store.save(legacy);
    assert.deepEqual(await store.load(), legacy);
    const approved = { ...legacy, sessionProjectRoots: { worker: root }, completionApproved: true };
    await store.save(approved);
    assert.deepEqual(await store.load(), approved);
    for (const invalid of [ { ...legacy, completionApproved: "true" }, { ...approved, mainAgentReviewPending: true }, { ...legacy, sessionProjectRoots: { worker: 123 } } ]) {
      await writeFile(store.path, JSON.stringify(invalid));
      await assert.rejects(store.load(), /Invalid DevOS state/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects malformed proven pre-submit retry markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-presubmit-state-"));
  try {
    const store = new JsonStateStore(root, { repo: "owner/product", issue: 620 });
    const state = { currentWorkerId: "browser", completedRuns: 0, sessions: {}, browserWorkersStarted: ["browser"] };
    await store.save(state);
    for (const browserPreSubmitRetry of ["browser", [1], ["browser", "browser"], [""]]) {
      await writeFile(store.path, JSON.stringify({ ...state, browserPreSubmitRetry }));
      await assert.rejects(store.load(), /Invalid DevOS state/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("state saves use unique same-directory temporary paths", () => {
  const target = "/tmp/project/.devos/state/owner%2Frepo-issue-1.json";
  const first = stateTemporaryPath(target, 123, "one");
  const second = stateTemporaryPath(target, 123, "two");
  assert.notEqual(first, second);
  assert.equal(first, target + ".tmp.123.one");
  assert.equal(second, target + ".tmp.123.two");
});

test("rejects invalid active MCP report proof instead of accepting a stale or malformed turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));
  const store = new JsonStateStore(root, { repo: "owner/project", issue: 103 });
  try {
    const base = { currentWorkerId: "reviewer", completedRuns: 0, sessions: {} };
    for (const bad of [
      { workerId: "reviewer", turn: 0, tokenHash: "invalid" },
      { workerId: "", turn: 0, tokenHash: "a".repeat(64) },
      { workerId: "reviewer", turn: -1, tokenHash: "a".repeat(64) },
      { workerId: "reviewer", turn: 0, tokenHash: "a".repeat(64), extra: "ignored" },
    ]) await assert.rejects(store.save({ ...base, activeReport: bad } as any), /Invalid DevOS active report/);
    await store.save({ ...base, activeReport: {
      workerId: "reviewer", turn: 0, tokenHash: "f".repeat(64),
    } });
    assert.equal((await store.load())?.activeReport?.tokenHash, "f".repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
