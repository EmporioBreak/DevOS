import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserRuntimePaths, closeSharedBrowserRuntime } from "../src/shared-browser-runtime.js";
import { processExists } from "../src/process-identity.js";

test("close after final handoff kills the exact idle detached runtime, not unrelated processes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-runtime-exit-"));
  const task = { repo: "owner/process-lifecycle-qa", issue: 4331 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  const script = fileURLToPath(new URL("./fixtures/stuck-browser-runtime.ts", import.meta.url));
  const child = spawn(process.execPath,
    ["--import", "tsx", script, "--devos-browser-runtime", paths.socket, paths.metadata],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"],
    { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fixture readiness timeout")), 10_000);
      child.stdout!.on("data", chunk => {
        if (String(chunk).includes("IDLE_RUNTIME_READY")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", code => reject(new Error("runtime fixture exited early: " + code)));
    });
    const info = JSON.parse(await readFile(paths.metadata, "utf8"));
    assert.equal(info.pid, child.pid);
    assert.ok(await processExists(child.pid!));
    assert.ok(await processExists(unrelated.pid!));
    await closeSharedBrowserRuntime(root, task);
    await new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(() => reject(new Error("runtime child still alive")), 3_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(await processExists(child.pid!), false);
    assert.equal(await processExists(unrelated.pid!), true, "never kill an unrelated Node process");
    await assert.rejects(readFile(paths.metadata), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGTERM");
    await rm(paths.socket, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
