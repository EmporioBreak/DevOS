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

// Every disposable group is also killed by the fixture's finally/watchdog path.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`caller ${signal} cleans only its owned worker group`, { skip: process.platform === "win32", timeout: 8000 }, async () => {
    const { spawn } = await import("node:child_process");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/devos-signal-`);
    const caller = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { LocalCommandRunner } from './src/command-runner.ts';
      await new LocalCommandRunner().run(process.execPath, ['-e', \`
        require('node:fs').writeFileSync(${JSON.stringify(`${dir}/pid`)}, String(process.pid));
        const descendant = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ['ignore', 'inherit', 'inherit']});
        require('node:fs').writeFileSync(${JSON.stringify(`${dir}/descendant`)}, String(descendant.pid));
        setInterval(() => {}, 1000);
      \`], process.cwd());
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    let group: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let descendant: number | undefined;
    const exited = new Promise(resolve => caller.on("exit", resolve));
    try {
      const deadline = Date.now() + 3000;
      while ((!group || !descendant) && Date.now() < deadline) {
        try { group = Number(await readFile(`${dir}/pid`, "utf8")); } catch {}
        try { descendant = Number(await readFile(`${dir}/descendant`, "utf8")); } catch {}
        if (!group || !descendant) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(group && descendant, "worker and descendant pids must be available");
      process.kill(caller.pid!, signal);
      await Promise.race([exited, new Promise((_, reject) => (timeout = setTimeout(() => reject(new Error("caller lingered")), 2000)))]);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.throws(() => process.kill(group!, 0), /ESRCH/);
      assert.throws(() => process.kill(descendant!, 0), /ESRCH/);
      process.kill(unrelated.pid!, 0);
    } finally {
      clearTimeout(timeout);
      if (!group) { try { group = Number(await readFile(`${dir}/pid`, "utf8")); } catch {} }
      if (group) { try { process.kill(-group, "SIGKILL"); } catch {} }
      caller.kill("SIGKILL"); unrelated.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("completion kills descendants after wrapper exit", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/devos-process-`);
  let group: number | undefined;
  const timer = setTimeout(async () => {
    try { group = Number(await readFile(`${dir}/pid`, "utf8")); process.kill(-group, "SIGKILL"); } catch {}
  }, 2000);
  try {
    const descendant = "setTimeout(() => console.log('ready'), 200); setInterval(() => {}, 1000)";
    const start = Date.now();
    const result = await new LocalCommandRunner().run(process.execPath, ["-e", `
      require('node:fs').writeFileSync(${JSON.stringify(`${dir}/pid`)}, String(process.pid));
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'inherit', 'inherit']});
      require('node:fs').writeFileSync(${JSON.stringify(`${dir}/descendant`)}, String(child.pid));
      child.unref();
    `], process.cwd(), undefined, { completeWhenOutput: stdout => stdout.includes("ready") });
    group = Number(await readFile(`${dir}/pid`, "utf8"));
    assert.ok(Date.now() - start < 1500, "must clean pipes before watchdog cleanup");
    assert.equal(result.completedEarly, true);
    const descendantPid = Number(await readFile(`${dir}/descendant`, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
  } finally {
    clearTimeout(timer);
    if (!group) { try { group = Number(await readFile(`${dir}/pid`, "utf8")); } catch {} }
    if (group) { try { process.kill(-group, "SIGKILL"); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
});

test("early stdin closure produces diagnostics without unhandled EPIPE", async () => {
  const result = await new LocalCommandRunner().run(process.execPath, ["-e", "process.exit(7)"], process.cwd(), "x".repeat(4 * 1024 * 1024));
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /stdin.*EPIPE/);
});

test("signal listeners are restored after a command", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await new LocalCommandRunner().run(process.execPath, ["-e", ""], process.cwd());
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});
