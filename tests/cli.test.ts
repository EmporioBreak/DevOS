import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli.js";

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
