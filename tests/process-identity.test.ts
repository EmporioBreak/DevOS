import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

test("process identity stays stable when the parent locale changes", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const previousLocale = process.env.LC_ALL;
  try {
    process.env.LC_ALL = "ru_RU.UTF-8";
    const localized = await captureProcessIdentity(child.pid!);
    process.env.LC_ALL = "C";
    const canonical = await captureProcessIdentity(child.pid!);

    assert.ok(localized);
    assert.ok(canonical);
    assert.equal(localized.startTime, canonical.startTime);
    assert.equal(sameProcessIdentity(localized, canonical), true);

    const legacyLocalizedStartTime = spawnSync(
      "/bin/ps",
      ["-p", String(child.pid), "-o", "lstart="],
      { env: { ...process.env, LC_ALL: "ru_RU.UTF-8" }, encoding: "utf8" },
    ).stdout.trim();
    assert.notEqual(legacyLocalizedStartTime, canonical.startTime);
    assert.equal(
      sameProcessIdentity(
        { ...canonical, startTime: legacyLocalizedStartTime },
        canonical,
      ),
      true,
      "saved identities from older locale-dependent versions remain provable",
    );
  } finally {
    if (previousLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = previousLocale;
    child.kill("SIGKILL");
  }
});

test("exited process is not a valid identity", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise(resolve => child.once("exit", resolve));
  assert.equal(await processExists(child.pid!), false);
  assert.equal(await captureProcessIdentity(child.pid!), null);
});
