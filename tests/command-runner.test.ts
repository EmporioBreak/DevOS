import assert from "node:assert/strict";
import test from "node:test";
import { LocalCommandRunner } from "../src/command-runner.js";

test("captures the terminating process signal", { skip: process.platform === "win32" }, async () => {
  const result = await new LocalCommandRunner().run(
    process.execPath,
    ["-e", "process.kill(process.pid, 'SIGTERM')"],
    process.cwd(),
  );

  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.exitCode, 1);
});
