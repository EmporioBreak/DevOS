import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandRunner } from "../src/command-runner.js";
import { resolveTaskReference } from "../src/task-reference.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; cwd: string }> = [];

  constructor(private readonly result: CommandResult) {}

  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    this.calls.push({ command, args, cwd });
    return this.result;
  }
}

test("resolves a PR created after an Issue-only workflow started", async () => {
  const runner = new FakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 40, body: "Implements #39.\n\nAdds task sessions." },
    ]),
    stderr: "",
  });

  const task = await resolveTaskReference(
    { repo: "owner/product", issue: 39 },
    "/project",
    runner,
  );

  assert.deepEqual(task, { repo: "owner/product", issue: 39, pr: 40 });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0]?.args, [
    "pr",
    "list",
    "--repo",
    "owner/product",
    "--state",
    "all",
    "--search",
    "#39 in:body",
    "--limit",
    "100",
    "--json",
    "number,body",
  ]);
});

test("prefers a unique closing PR when several PRs mention the Issue", async () => {
  const runner = new FakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 40, body: "Related to #39." },
      { number: 41, body: "Fixes owner/product#39." },
    ]),
    stderr: "",
  });

  assert.deepEqual(
    await resolveTaskReference(
      { repo: "owner/product", issue: 39 },
      "/project",
      runner,
    ),
    { repo: "owner/product", issue: 39, pr: 41 },
  );
});

test("does not guess when several non-closing PRs mention the Issue", async () => {
  const runner = new FakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 40, body: "Related to #39." },
      { number: 41, body: "Also discusses #39." },
    ]),
    stderr: "",
  });

  assert.deepEqual(
    await resolveTaskReference(
      { repo: "owner/product", issue: 39 },
      "/project",
      runner,
    ),
    { repo: "owner/product", issue: 39 },
  );
});

test("keeps a preconfigured PR without querying GitHub", async () => {
  const runner = new FakeRunner({
    exitCode: 1,
    stdout: "",
    stderr: "should not run",
  });

  assert.deepEqual(
    await resolveTaskReference(
      { repo: "owner/product", issue: 39, pr: 40 },
      "/project",
      runner,
    ),
    { repo: "owner/product", issue: 39, pr: 40 },
  );
  assert.equal(runner.calls.length, 0);
});
