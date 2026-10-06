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


test("writes supplied stdin and closes it", async () => {
  const result = await new LocalCommandRunner().run(
    process.execPath,
    ["-e", "process.stdin.setEncoding('utf8'); let data=''; process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => process.stdout.write(data));"],
    process.cwd(),
    "prompt over stdin",
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "prompt over stdin");
});

test("finishes after matching complete stdout and kills the lingering child", async () => {
  const startedAt = Date.now();
  const result = await new LocalCommandRunner().run(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    process.cwd(),
    undefined,
    { completeWhenOutput: stdout => stdout.includes("ready\n") },
  );

  assert.ok(Date.now() - startedAt < 1_000, "runner should not wait for natural process exit");
  assert.equal(result.completedEarly, true);
  assert.match(result.stdout, /ready/);
  assert.notEqual(result.signal, null);
});
