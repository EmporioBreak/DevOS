import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isCliEntrypoint, parseCliArgs } from "../src/cli.js";

test("accepts the run command", () => {
  assert.deepEqual(parseCliArgs(["run", ".devos/workflow.json"]), {
    workflowPath: ".devos/workflow.json",
  });
});

test("rejects unsupported CLI shapes", () => {
  assert.throws(() => parseCliArgs([]), /Usage: devos run/);
  assert.throws(() => parseCliArgs(["start", "workflow.json"]), /Usage: devos run/);
  assert.throws(() => parseCliArgs(["run"]), /Usage: devos run/);
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
