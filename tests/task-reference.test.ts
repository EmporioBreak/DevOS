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
    "open",
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

test("selects the open task PR instead of a merged stale incidental mention", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(_command, args) {
      calls.push(args);
      const state = args[args.indexOf("--state") + 1];
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          state === "open"
            ? [{ number: 56, body: "Implements the requested owner handoff. Related to #42." }]
            : [
                { number: 53, body: "Started while investigating #42; unrelated bootstrap fix." },
                { number: 56, body: "Implements the requested owner handoff. Related to #42." },
              ],
        ),
        stderr: "",
      };
    },
  };

  assert.deepEqual(
    await resolveTaskReference(
      { repo: "EmporioBreak/DevOS", issue: 42 },
      "/project",
      runner,
    ),
    { repo: "EmporioBreak/DevOS", issue: 42, pr: 56 },
  );
  assert.equal(calls[0]?.[calls[0]?.indexOf("--state") + 1], "open");
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

test("keeps the Issue reference when the optional gh lookup cannot start", async () => {
  const runner: CommandRunner = {
    async run() {
      throw new Error("gh is not installed");
    },
  };

  assert.deepEqual(
    await resolveTaskReference(
      { repo: "owner/product", issue: 39 },
      "/project",
      runner,
    ),
    { repo: "owner/product", issue: 39 },
  );
});


test("resolves full GitHub Issue URL references in the current repository", async () => {
  const runner = new FakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 40, body: "Related to https://github.com/owner/product/issues/39." },
      { number: 41, body: "Fixes https://github.com/owner/product/issues/39" },
    ]),
    stderr: "",
  });

  assert.deepEqual(
    await resolveTaskReference({ repo: "owner/product", issue: 39 }, "/project", runner),
    { repo: "owner/product", issue: 39, pr: 41 },
  );
});

test("does not match cross-repository full Issue URLs", async () => {
  const runner = new FakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 40, body: "Fixes https://github.com/other/product/issues/39" },
    ]),
    stderr: "",
  });

  assert.deepEqual(
    await resolveTaskReference({ repo: "owner/product", issue: 39 }, "/project", runner),
    { repo: "owner/product", issue: 39 },
  );
});

test("refuses ambiguity between multiple closing references", async () => {
  const runner = new FakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      { number: 40, body: "Fixes #39" },
      { number: 41, body: "Closes https://github.com/owner/product/issues/39" },
    ]),
    stderr: "",
  });

  assert.deepEqual(
    await resolveTaskReference({ repo: "owner/product", issue: 39 }, "/project", runner),
    { repo: "owner/product", issue: 39 },
  );
});
