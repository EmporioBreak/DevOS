import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { terminateOwnedChildAndWait } from "./fixtures/owned-child-cleanup.js";

test("waits for owned child teardown before deleting its temporary tree", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-owned-child-cleanup-"));
  const marker = join(root, "owned", "late-cleanup", "done");
  const script = [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "process.on('SIGTERM',()=>setTimeout(()=>{",
    "fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});",
    "fs.writeFileSync(process.argv[1],'done'); process.exit(0);",
    "},75));",
    "process.stdout.write('READY\\n');",
    "setInterval(()=>{},1000);",
  ].join("");
  const child = spawn(process.execPath, ["-e", script, marker], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("child fixture readiness timeout")), 2_000);
      child.stdout!.once("data", () => { clearTimeout(timeout); resolve(); });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`child fixture exited early: ${code}`)); });
    });
    await terminateOwnedChildAndWait(child, 2_000);
    assert.equal(await readFile(marker, "utf8"), "done");
    await rm(root, { recursive: true, force: true });
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
