import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireTaskLock, taskLockPath } from "../src/task-lock.js";

test("second live task owner is rejected", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-lock-"));
  const task = { repo: "owner/repo", issue: 7 };
  const first = await acquireTaskLock(root, task);
  try {
    await assert.rejects(acquireTaskLock(root, task), /already owned by DevOS process/);
  } finally {
    await first.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale dead lock is replaced safely", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-lock-"));
  const task = { repo: "owner/repo", issue: 8 };
  const path = taskLockPath(root, task);
  await (await import("node:fs/promises")).mkdir(join(root, ".devos", "locks"), { recursive: true });
  await writeFile(path, JSON.stringify({
    repo: task.repo,
    issue: task.issue,
    pid: 999999,
    identity: { pid: 999999, startTime: "old", executable: "/old" },
    runId: "stale",
    startedAt: new Date(0).toISOString(),
  }));
  const lock = await acquireTaskLock(root, task);
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    assert.notEqual(state.runId, "stale");
  } finally {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  }
});


test("ambiguous partial lock is never removed automatically", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-lock-"));
  const task = { repo: "owner/repo", issue: 9 };
  const path = taskLockPath(root, task);
  await (await import("node:fs/promises")).mkdir(join(root, ".devos", "locks"), { recursive: true });
  await writeFile(path, "");
  try {
    await assert.rejects(
      acquireTaskLock(root, task),
      /ownership cannot be validated/,
    );
    assert.equal(await readFile(path, "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
