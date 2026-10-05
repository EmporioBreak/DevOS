import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { RunState, StateStore } from "../src/orchestrator.js";
import { isCliEntrypoint, parseCliArgs, prepareRunState } from "../src/cli.js";

class TrackingStore implements StateStore {
  cleared = 0;
  async load(): Promise<RunState | null> { return null; }
  async save(_state: RunState): Promise<void> {}
  async clear(): Promise<void> { this.cleared += 1; }
}

test("accepts run, restart, and watch commands", () => {
  assert.deepEqual(parseCliArgs(["run", ".devos/workflow.json"]), {
    kind: "workflow",
    mode: "run",
    workflowPath: ".devos/workflow.json",
  });
  assert.deepEqual(parseCliArgs(["restart", ".devos/workflow.json"]), {
    kind: "workflow",
    mode: "restart",
    workflowPath: ".devos/workflow.json",
  });
  assert.deepEqual(parseCliArgs(["watch", "owner/product"]), {
    kind: "watch",
    repo: "owner/product",
  });
});

test("rejects unsupported CLI shapes", () => {
  assert.throws(() => parseCliArgs([]), /Usage: devos/);
  assert.throws(() => parseCliArgs(["start", "workflow.json"]), /Usage: devos/);
  assert.throws(() => parseCliArgs(["run"]), /Usage: devos/);
  assert.throws(() => parseCliArgs(["watch", "not-a-repo"]), /Usage: devos/);
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
