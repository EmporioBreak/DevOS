import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommandResult, CommandRunner } from "../src/command-runner.js";
import {
  listReadyTasks,
  loadOrCreateProjectConfig,
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
