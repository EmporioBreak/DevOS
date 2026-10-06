import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { RunState, StateStore } from "../src/orchestrator.js";
import {
  assertOwnerDecisionPending,
  chooseReadyTask,
  formatRunResult,
  isCliEntrypoint,
  parseCliArgs,
  parseIssueNumber,
  parseParentOwnerDecision,
  prepareRunState,
} from "../src/cli.js";
import type { ReadyTask } from "../src/ready-tasks.js";

class TrackingStore implements StateStore {
  cleared = 0;
  async load(): Promise<RunState | null> { return null; }
  async save(_state: RunState): Promise<void> {}
  async clear(): Promise<void> { this.cleared += 1; }
}

test("accepts interactive, file, and issue run commands", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "select" });
  assert.deepEqual(parseCliArgs(["run", ".devos/workflow.json"]), {
    kind: "run",
    mode: "run",
    target: ".devos/workflow.json",
  });
  assert.deepEqual(parseCliArgs(["restart", "35"]), {
    kind: "run",
    mode: "restart",
    target: "35",
  });
});

test("rejects unsupported CLI shapes including watch", () => {
  assert.throws(() => parseCliArgs(["start", "workflow.json"]), /Usage: \.\/devos/);
  assert.throws(() => parseCliArgs(["run"]), /Usage: \.\/devos/);
  assert.throws(() => parseCliArgs(["watch", "owner/product"]), /Usage: \.\/devos/);
});

test("parses positive numeric targets as issue numbers", () => {
  assert.equal(parseIssueNumber("35"), 35);
  assert.equal(parseIssueNumber(".devos/workflow.json"), null);
  assert.equal(parseIssueNumber("35.json"), null);
  assert.throws(() => parseIssueNumber("0"), /positive integer/);
});

test("selects a ready task by menu position", () => {
  const tasks = [
    { issue: 35, title: "A" },
    { issue: 36, title: "B" },
  ] as ReadyTask[];

  assert.equal(chooseReadyTask(tasks, "2").issue, 36);
  assert.throws(() => chooseReadyTask(tasks, "0"), /Invalid task selection/);
  assert.throws(() => chooseReadyTask(tasks, "x"), /Invalid task selection/);
});

test("restart clears state while run preserves it", async () => {
  const store = new TrackingStore();

  await prepareRunState("run", store);
  assert.equal(store.cleared, 0);

  await prepareRunState("restart", store);
  assert.equal(store.cleared, 1);
});

test("recognizes a symlinked package bin as the CLI entry point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "devos-cli-test-"));
  const target = join(directory, "cli.js");
  const bin = join(directory, "devos");

  try {
    await writeFile(target, "");
    await symlink(target, bin);
    assert.equal(isCliEntrypoint(pathToFileURL(target).href, bin), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("parses parent-process final review decisions", () => {
  assert.equal(parseParentOwnerDecision(undefined), undefined);
  assert.equal(parseParentOwnerDecision("approved"), "approved");
  assert.equal(
    parseParentOwnerDecision("changes_requested"),
    "changes_requested",
  );
  assert.throws(
    () => parseParentOwnerDecision("done"),
    /DEVOS_OWNER_RESULT must be approved or changes_requested/,
  );
});


test("formats parent-process final review handoff as structured stdout", () => {
  const line = formatRunResult(
    {
      version: 1,
      task: { repo: "owner/product", issue: 39, pr: 41 },
      owner: { mode: "parent_process" },
      start: "reviewer",
      workers: [
        {
          id: "reviewer",
          executor: "chatgpt_browser",
          prompt: "Review.",
          on: { approved: null },
        },
      ],
    },
    {
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: { reviewer: "https://chatgpt.com/c/review" },
      ownerReviewPending: true,
    },
  );

  assert.equal(
    line,
    'DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED","task":{"repo":"owner/product","issue":39,"pr":41}}\n',
  );
});


test("parent-process handoff uses PR resolved during execution", () => {
  const line = formatRunResult(
    {
      version: 1,
      task: { repo: "owner/product", issue: 39 },
      owner: { mode: "parent_process" },
      start: "reviewer",
      workers: [
        {
          id: "reviewer",
          executor: "chatgpt_browser",
          prompt: "Review.",
          on: { approved: null },
        },
      ],
    },
    {
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: { reviewer: "https://chatgpt.com/c/review" },
      task: { repo: "owner/product", issue: 39, pr: 40 },
      ownerReviewPending: true,
    },
  );

  assert.equal(
    line,
    'DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED","task":{"repo":"owner/product","issue":39,"pr":40}}\n',
  );
});


test("owner decision requires an existing final-review handoff", () => {
  assert.throws(
    () => assertOwnerDecisionPending(null),
    /requires an existing task waiting for final review/,
  );
  assert.throws(
    () =>
      assertOwnerDecisionPending({
        currentWorkerId: "reviewer",
        completedRuns: 1,
        sessions: {},
      }),
    /requires an existing task waiting for final review/,
  );

  assert.doesNotThrow(() =>
    assertOwnerDecisionPending({
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: {},
      ownerReviewPending: true,
    }),
  );
});
