import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { RunState, StateStore } from "../src/orchestrator.js";
import {
  assertMainAgentDecisionPending,
  assertWorkflowMatchesProject,
  chooseReadyTask,
  cliBrowserRuntimeDeps,
  formatRunResult,
  isCliEntrypoint,
  parseCliArgs,
  parseIssueNumber,
  parseMainAgentDecision,
  prepareRunState,
  runWorkflow,
} from "../src/cli.js";
import type { ReadyTask } from "../src/ready-tasks.js";
import type { Workflow } from "../src/workflow.js";

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


test("parses main-agent final review decisions", () => {
  assert.equal(parseMainAgentDecision(undefined), undefined);
  assert.equal(parseMainAgentDecision("approved"), "approved");
  assert.equal(
    parseMainAgentDecision("changes_requested"),
    "changes_requested",
  );
  assert.throws(
    () => parseMainAgentDecision("done"),
    /DEVOS_OWNER_RESULT must be approved or changes_requested/,
  );
});


test("formats main-agent final review handoff as structured stdout", () => {
  const line = formatRunResult(
    {
      version: 1,
      task: { repo: "owner/product", issue: 39, pr: 41 },
      owner: { mode: "main_agent" },
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
      mainAgentReviewPending: true,
    },
  );

  assert.equal(
    line,
    'DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED","task":{"repo":"owner/product","issue":39,"pr":41}}\n',
  );
});


test("main-agent handoff uses PR resolved during execution", () => {
  const line = formatRunResult(
    {
      version: 1,
      task: { repo: "owner/product", issue: 39 },
      owner: { mode: "main_agent" },
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
      mainAgentReviewPending: true,
    },
  );

  assert.equal(
    line,
    'DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED","task":{"repo":"owner/product","issue":39,"pr":40}}\n',
  );
});


test("main-agent decision requires an existing final-review handoff", () => {
  assert.throws(
    () => assertMainAgentDecisionPending(null),
    /requires an existing task waiting for final review/,
  );
  assert.throws(
    () =>
      assertMainAgentDecisionPending({
        currentWorkerId: "reviewer",
        completedRuns: 1,
        sessions: {},
      }),
    /requires an existing task waiting for final review/,
  );

  assert.doesNotThrow(() =>
    assertMainAgentDecisionPending({
      currentWorkerId: "reviewer",
      completedRuns: 1,
      sessions: {},
      mainAgentReviewPending: true,
    }),
  );
});


test("rejects workflow repository mismatch before execution", () => {
  assert.doesNotThrow(() => assertWorkflowMatchesProject(
    { version: 1, task: { repo: "owner/project", issue: 1 }, start: "worker", workers: [{ id: "worker", executor: "codex", prompt: "x", on: { done: null } }] },
    { version: 1, repo: "owner/project", chatgptProjectUrl: "https://chatgpt.com/" },
  ));
  assert.throws(() => assertWorkflowMatchesProject(
    { version: 1, task: { repo: "other/repo", issue: 1 }, start: "worker", workers: [{ id: "worker", executor: "codex", prompt: "x", on: { done: null } }] },
    { version: 1, repo: "owner/project", chatgptProjectUrl: "https://chatgpt.com/" },
  ), /Workflow repository other\/repo does not match current project owner\/project/);
});

test("shared browser runtime survives final review handoff and closes only after approval", async t => {
  const root = await mkdtemp(join(tmpdir(), "devos-cli-shared-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 740, pr: 90 },
    owner: { mode: "main_agent" },
    start: "reviewer",
    workers: [
      {
        id: "reviewer",
        executor: "chatgpt_browser",
        prompt: "Review.",
        on: { approved: null },
      },
    ],
  };
  let workerRuns = 0;
  let closes = 0;
  const browser = {
    kind: "chatgpt_browser" as const,
    async run(request: { onSession?: (sessionId: string) => void | Promise<void> }) {
      workerRuns++;
      await request.onSession?.("https://chatgpt.com/c/review-740");
      return {
        text: 'DEVOS_RESULT {"status":"approved"}',
        sessionId: "https://chatgpt.com/c/review-740",
      };
    },
  };
  t.mock.method(cliBrowserRuntimeDeps, "ensure", async () => browser as never);
  t.mock.method(cliBrowserRuntimeDeps, "close", async () => { closes++; });

  const previousOwnerResult = process.env.DEVOS_OWNER_RESULT;
  delete process.env.DEVOS_OWNER_RESULT;
  t.after(() => {
    if (previousOwnerResult === undefined) delete process.env.DEVOS_OWNER_RESULT;
    else process.env.DEVOS_OWNER_RESULT = previousOwnerResult;
  });

  const config = {
    version: 1 as const,
    repo: "owner/product",
    chatgptProjectUrl: "https://chatgpt.com/",
  };

  const handoff = await runWorkflow(workflow, "run", root, config);
  assert.equal(handoff.mainAgentReviewPending, true);
  assert.equal(workerRuns, 1);
  assert.equal(closes, 0);

  process.env.DEVOS_OWNER_RESULT = "approved";
  const completed = await runWorkflow(workflow, "run", root, config);
  assert.equal(completed.completionApproved, true);
  assert.equal(workerRuns, 1, "approval must not rerun the reviewer");
  assert.equal(closes, 1);
});
