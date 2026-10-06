import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandResult, CommandRunner } from "../src/command-runner.js";
import {
  clearTaskCompletion,
  isTaskCompleted,
  listReadyTasks,
  loadOrCreateProjectConfig,
  loadReadyTask,
  markTaskCompleted,
  parseGitHubRepo,
  parseReadyTaskBody,
} from "../src/ready-tasks.js";

const workflow = {
  version: 1,
  task: { repo: "owner/product", issue: 42 },
  start: "developer",
  workers: [
    {
      id: "developer",
      executor: "chatgpt_browser",
      prompt: "Implement the task.",
      on: { done: null },
    },
  ],
};

function body(): string {
  return [
    "# Ready task",
    "",
    "<!-- DEVOS_TASK_V1 -->",
    "```json",
    JSON.stringify({ version: 1, mode: "run", workflow }, null, 2),
    "```",
  ].join("\n");
}

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  constructor(private readonly responses: CommandResult[]) {}

  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    this.calls.push({ command, args, cwd });
    const result = this.responses.shift();
    if (!result) throw new Error("Unexpected command");
    return result;
  }
}

test("parses common GitHub origin formats", () => {
  assert.equal(parseGitHubRepo("git@github.com:owner/product.git"), "owner/product");
  assert.equal(parseGitHubRepo("https://github.com/owner/product.git"), "owner/product");
  assert.equal(parseGitHubRepo("https://github.com/owner/product"), "owner/product");
});

test("parses a ready task only when workflow matches its issue", () => {
  const task = parseReadyTaskBody(body(), "owner/product", 42, "Homepage");
  assert.equal(task?.issue, 42);
  assert.equal(task?.title, "Homepage");
  assert.equal(task?.workflow.start, "developer");

  assert.throws(
    () => parseReadyTaskBody(body(), "owner/product", 41, "Wrong issue"),
    /does not match project task/,
  );
});

test("creates project-local config from git origin without a GitHub request", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-ready-task-"));
  const runner = new FakeRunner([
    { exitCode: 0, stdout: "git@github.com:owner/product.git\n", stderr: "" },
  ]);

  try {
    const config = await loadOrCreateProjectConfig(root, runner);
    assert.deepEqual(config, { version: 1, repo: "owner/product" });
    assert.equal(runner.calls.length, 1);
    assert.equal(runner.calls[0]?.command, "git");

    const saved = JSON.parse(
      await readFile(join(root, ".devos", "config.json"), "utf8"),
    );
    assert.deepEqual(saved, config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads project-local ChatGPT Project URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-ready-task-"));
  const runner = new FakeRunner([]);

  try {
    await mkdir(join(root, ".devos"), { recursive: true });
    await writeFile(
      join(root, ".devos", "config.json"),
      JSON.stringify({
        version: 1,
        repo: "owner/product",
        chatgptProjectUrl: "https://chatgpt.com/g/project/c/",
      }),
    );

    assert.deepEqual(await loadOrCreateProjectConfig(root, runner), {
      version: 1,
      repo: "owner/product",
      chatgptProjectUrl: "https://chatgpt.com/g/project/c/",
    });
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists owned ready issues with one GitHub request", async () => {
  const runner = new FakeRunner([
    {
      exitCode: 0,
      stdout: JSON.stringify([
        { number: 41, title: "Not ready", body: "plain issue" },
        { number: 42, title: "Homepage", body: body() },
      ]),
      stderr: "",
    },
  ]);

  const tasks = await listReadyTasks(
    { version: 1, repo: "owner/product" },
    "/project",
    runner,
  );

  assert.deepEqual(tasks.map(task => task.issue), [42]);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]?.command, "gh");
  assert.ok(runner.calls[0]?.args.includes("--author"));
  assert.ok(runner.calls[0]?.args.includes("@me"));
});


test("direct issue load rejects closed tasks by default", async () => {
  const runner = new FakeRunner([
    {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        title: "Homepage",
        body: body(),
        state: "CLOSED",
      }),
      stderr: "",
    },
  ]);

  await assert.rejects(
    loadReadyTask(
      { version: 1, repo: "owner/product" },
      42,
      "/project",
      runner,
    ),
    /not an open ready DevOS task/,
  );
});

test("direct issue load can read a closed task for guarded owner continuation", async () => {
  const runner = new FakeRunner([
    {
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        title: "Homepage",
        body: body(),
        state: "CLOSED",
      }),
      stderr: "",
    },
  ]);

  const task = await loadReadyTask(
    { version: 1, repo: "owner/product" },
    42,
    "/project",
    runner,
    true,
  );

  assert.equal(task.issue, 42);
  assert.equal(task.workflow.task.issue, 42);
});


test("tracks project-local completion markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-completed-task-"));
  try {
    assert.equal(await isTaskCompleted(root, 42), false);
    await markTaskCompleted(root, 42);
    assert.equal(await isTaskCompleted(root, 42), true);
    await clearTaskCompletion(root, 42);
    assert.equal(await isTaskCompleted(root, 42), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hides completed ready tasks from the picker", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-completed-picker-"));
  const runner = new FakeRunner([{
    exitCode: 0,
    stdout: JSON.stringify([{ number: 42, title: "Homepage", body: body() }]),
    stderr: "",
  }]);
  try {
    await markTaskCompleted(root, 42);
    const tasks = await listReadyTasks(
      { version: 1, repo: "owner/product" }, root, runner,
    );
    assert.deepEqual(tasks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct run refuses completed tasks while explicit restart may load them", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-completed-direct-"));
  const response = {
    exitCode: 0,
    stdout: JSON.stringify({ number: 42, title: "Homepage", body: body(), state: "OPEN" }),
    stderr: "",
  };
  try {
    await markTaskCompleted(root, 42);
    await assert.rejects(
      loadReadyTask(
        { version: 1, repo: "owner/product" }, 42, root,
        new FakeRunner([response]), false, false,
      ),
      /already completed.*restart 42/i,
    );
    const task = await loadReadyTask(
      { version: 1, repo: "owner/product" }, 42, root,
      new FakeRunner([response]), false, true,
    );
    assert.equal(task.issue, 42);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
