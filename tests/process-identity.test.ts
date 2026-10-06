import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  captureProcessIdentity,
  processExists,
  sameProcessIdentity,
} from "../src/process-identity.js";

test("captures stable identity for a live process", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    const identity = await captureProcessIdentity(child.pid!);
    assert.ok(identity);
    assert.equal(identity.pid, child.pid);
    assert.ok(identity.startTime);
    assert.ok(identity.executable);
    assert.equal(await processExists(child.pid!), true);
    assert.equal(sameProcessIdentity(identity, { ...identity }), true);
    assert.equal(sameProcessIdentity(identity, { ...identity, startTime: identity.startTime + "-different" }), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("exited process is not a valid identity", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise(resolve => child.once("exit", resolve));
  assert.equal(await processExists(child.pid!), false);
  assert.equal(await captureProcessIdentity(child.pid!), null);
});
