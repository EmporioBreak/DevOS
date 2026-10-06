import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearTaskCompleted,
  isTaskCompleted,
  markTaskCompleted,
  recordTaskCompletion,
} from "../src/completed-tasks.js";

test("completion markers persist and can be cleared for restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-completed-"));
  try {
    assert.equal(await isTaskCompleted(root, 37), false);
    await markTaskCompleted(root, 37);
    assert.equal(await isTaskCompleted(root, 37), true);
    await clearTaskCompleted(root, 37);
    assert.equal(await isTaskCompleted(root, 37), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FINAL_REVIEW_REQUIRED leaves completion unmarked until approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-completed-"));
  try {
    const pendingReview = {
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: {},
      mainAgentReviewPending: true,
    };
    await recordTaskCompletion(root, 37, pendingReview);
    assert.equal(await isTaskCompleted(root, 37), false);

    const terminalApproval = {
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: {},
      task: { repo: "owner/product", issue: 37 },
    };
    await recordTaskCompletion(root, 37, terminalApproval);
    assert.equal(await isTaskCompleted(root, 37), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
