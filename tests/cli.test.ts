import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  main,
  parseCliArgs,
  parseIssueNumber,
  parseMainAgentDecision,
  prepareRunState,
  runWorkflow,
  workerReportsEnabled,
} from "../src/cli.js";
import type { ReadyTask } from "../src/ready-tasks.js";
import type { Workflow } from "../src/workflow.js";
import { isTaskCompleted } from "../src/completed-tasks.js";
import { JsonStateStore } from "../src/json-state-store.js";
import { DevosToolRegistry } from "../src/mcp-tools/registry.js";

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
  assert.throws(() => parseCliArgs(["bind-chat", "/tmp/marker"]), /Usage: \.\/devos/);
  assert.throws(() => parseCliArgs(["bind-chat", "--status"]), /Usage: \.\/devos/);
  assert.throws(() => parseCliArgs(["--devos-bind-chat-worker", "a", "b", "c"]), /Usage: \.\/devos/);
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

test("one browser stays alive through review and requested changes; close only after final approval", async t => {
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
  let ensures = 0;
  let processStarts = 0;
  let browserRunning = false;
  const browser = {
    kind: "chatgpt_browser" as const,
    async run(request: { prompt: string; onSession?: (sessionId: string) => void | Promise<void> }) {
      workerRuns++;
      const proof = /turn_token=([a-f0-9]{64})/.exec(request.prompt)?.[1];
      const turn = /turn=(\d+), turn_token=/.exec(request.prompt)?.[1];
      assert.ok(proof && turn);
      await request.onSession?.("https://chatgpt.com/c/review-740");
      const reported = await new DevosToolRegistry(root).call("devos_worker_report", {
        repo: "owner/product", issue: 740, worker_id: "reviewer",
        turn: Number(turn), turn_token: proof, status: "approved", summary: "QA fixture completed",
      });
      assert.equal(reported.isError, undefined);
      return {
        text: "",
        sessionId: "https://chatgpt.com/c/review-740",
      };
    },
  };
  t.mock.method(cliBrowserRuntimeDeps, "ensure", async () => {
    ensures++;
    if (!browserRunning) { browserRunning = true; processStarts++; }
    return browser as never;
  });
  t.mock.method(cliBrowserRuntimeDeps, "close", async () => {
    assert.equal(browserRunning, true, "must close only a previously started browser");
    browserRunning = false;
    closes++;
  });

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
  assert.equal(closes, 0, "handoff must not close the browser");
  assert.equal(ensures, 1);
  assert.equal(processStarts, 1);
  assert.equal(browserRunning, true);

  process.env.DEVOS_OWNER_RESULT = "changes_requested";
  const reworked = await runWorkflow(workflow, "run", root, config);
  assert.equal(reworked.mainAgentReviewPending, true);
  assert.equal(workerRuns, 2, "changes requested must resume the reviewer in its saved conversation");
  assert.equal(closes, 0, "re-review must not close any tab or browser");
  assert.equal(ensures, 2, "continuing the task reuses the task-scoped runtime");
  assert.equal(processStarts, 1, "never create a second browser within the task");
  assert.equal(browserRunning, true);

  process.env.DEVOS_OWNER_RESULT = "approved";
  const completed = await runWorkflow(workflow, "run", root, config);
  assert.equal(completed.completionApproved, true);
  assert.equal(workerRuns, 2, "approval must not rerun the reviewer");
  assert.equal(closes, 1, "only final approval closes the browser");
  assert.equal(browserRunning, false);
  assert.equal(ensures, 2, "owner approval must not start an empty browser");
  assert.equal(processStarts, 1);
});

test("browser cleanup failure preserves approved state and retries finalization without rerunning workers", async t => {
  const root = await mkdtemp(join(tmpdir(), "devos-cli-browser-cleanup-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 741, pr: 90 },
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
  let failClose = false;
  const browser = {
    kind: "chatgpt_browser" as const,
    async run(request: { prompt: string; onSession?: (sessionId: string) => void | Promise<void> }) {
      workerRuns++;
      const proof = /turn_token=([a-f0-9]{64})/.exec(request.prompt)?.[1];
      const turn = /turn=(\d+), turn_token=/.exec(request.prompt)?.[1];
      assert.ok(proof && turn);
      await request.onSession?.("https://chatgpt.com/c/review-741");
      const reported = await new DevosToolRegistry(root).call("devos_worker_report", {
        repo: "owner/product", issue: 741, worker_id: "reviewer",
        turn: Number(turn), turn_token: proof, status: "approved", summary: "QA fixture completed",
      });
      assert.equal(reported.isError, undefined);
      return {
        text: "",
        sessionId: "https://chatgpt.com/c/review-741",
      };
    },
  };
  t.mock.method(cliBrowserRuntimeDeps, "ensure", async () => browser as never);
  t.mock.method(cliBrowserRuntimeDeps, "close", async () => {
    closes++;
    if (failClose) throw new Error("simulated browser cleanup failure");
  });

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
  assert.equal(closes, 0, "handoff must retain the browser");
  failClose = true;

  process.env.DEVOS_OWNER_RESULT = "approved";
  await assert.rejects(
    runWorkflow(workflow, "run", root, config),
    /simulated browser cleanup failure/,
  );
  const store = new JsonStateStore(root, workflow.task);
  const pending = await store.load();
  assert.equal(pending?.completionApproved, true);
  assert.equal(pending?.sessions.reviewer, "https://chatgpt.com/c/review-741");
  assert.equal(await isTaskCompleted(root, workflow.task.issue), false);
  assert.equal(workerRuns, 1);
  assert.equal(closes, 1);

  failClose = false;
  delete process.env.DEVOS_OWNER_RESULT;
  const completed = await runWorkflow(workflow, "run", root, config);
  assert.equal(completed.completionApproved, true);
  assert.equal(workerRuns, 1, "cleanup retry must not rerun the reviewer");
  assert.equal(closes, 2);
  assert.equal(await isTaskCompleted(root, workflow.task.issue), true);
  assert.equal(await store.load(), null);
});

test("CLI rejects unsupported browser status fallback configuration", () => {
  assert.equal(workerReportsEnabled(undefined), true);
  assert.equal(workerReportsEnabled("1"), true);
  assert.throws(() => workerReportsEnabled("0"), /no longer supported/);
  assert.throws(() => workerReportsEnabled("off"), /must be 1/);
});

test("idle owner-review checks leave the browser intact and final-only cleanup can retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "devos-handoff-close-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow: Workflow = {
    version: 1,
    task: { repo: "owner/product", issue: 742 },
    owner: { mode: "main_agent" },
    start: "reviewer",
    workers: [{ id: "reviewer", executor: "chatgpt_browser",
      prompt: "Review.", on: { approved: null } }],
  };
  const oldDecision = process.env.DEVOS_OWNER_RESULT;
  delete process.env.DEVOS_OWNER_RESULT;
  t.after(() => {
    if (oldDecision === undefined) delete process.env.DEVOS_OWNER_RESULT;
    else process.env.DEVOS_OWNER_RESULT = oldDecision;
  });
  let workerRuns = 0;
  let ensured = 0;
  let closes = 0;
  const browser = {
    kind: "chatgpt_browser" as const,
    async run(request: { prompt: string; onSession?: (id: string) => void | Promise<void> }) {
      workerRuns++;
      const token = /turn_token=([a-f0-9]{64})/.exec(request.prompt)?.[1];
      const turn = /turn=(\d+), turn_token=/.exec(request.prompt)?.[1];
      assert.ok(token && turn);
      await request.onSession?.("https://chatgpt.com/c/review-742");
      const receipt = await new DevosToolRegistry(root).call("devos_worker_report", {
        repo: "owner/product", issue: 742, worker_id: "reviewer", turn: Number(turn),
        turn_token: token, status: "approved", summary: "Reviewer completed",
      });
      assert.equal(receipt.isError, undefined);
      return { text: "", sessionId: "https://chatgpt.com/c/review-742" };
    },
  };
  t.mock.method(cliBrowserRuntimeDeps, "ensure", async () => { ensured++; return browser as never; });
  t.mock.method(cliBrowserRuntimeDeps, "close", async () => {
    closes++;
    if (closes === 1) throw new Error("browser not fully terminated");
  });
  const config = { version: 1 as const, repo: "owner/product",
    chatgptProjectUrl: "https://chatgpt.com/" };
  const handoff = await runWorkflow(workflow, "run", root, config);
  assert.equal(handoff.mainAgentReviewPending, true);
  assert.equal(closes, 0, "first handoff is not final task completion");
  const persisted = await new JsonStateStore(root, workflow.task).load();
  assert.equal(persisted?.sessions.reviewer, "https://chatgpt.com/c/review-742");

  const repeatedHandoff = await runWorkflow(workflow, "run", root, config);
  assert.equal(repeatedHandoff.mainAgentReviewPending, true);
  assert.equal(closes, 0, "idle review check cannot close the browser");
  assert.equal(ensured, 1, "idle review check cannot open another browser");
  assert.equal(workerRuns, 1, "idle review check cannot resend the prompt");

  process.env.DEVOS_OWNER_RESULT = "approved";
  await assert.rejects(runWorkflow(workflow, "run", root, config),
    /browser not fully terminated/);
  const saved = await new JsonStateStore(root, workflow.task).load();
  assert.equal(saved?.completionApproved, true, "approval retained for safe cleanup retry");
  assert.equal(closes, 1);
  const completed = await runWorkflow(workflow, "run", root, config);
  assert.equal(completed.completionApproved, true);
  assert.equal(closes, 2, "second cleanup attempt succeeds");
  assert.equal(ensured, 1, "cleanup-only retry cannot start another browser");
  assert.equal(workerRuns, 1);
});
