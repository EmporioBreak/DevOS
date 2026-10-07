import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  camoufoxIdentityDeps,
  camoufoxIdentityPath,
  loadOrCreateCamoufoxIdentity,
} from "../src/camoufox-identity.js";

test("Camoufox identity is created once and reused for the same profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "devos-camoufox-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  const preset = { userAgent: "stable-preset", screen: { width: 1440, height: 900 } };
  let draws = 0;
  t.mock.method(camoufoxIdentityDeps, "getRandomPreset", () => {
    draws++;
    return preset as never;
  });

  const first = await loadOrCreateCamoufoxIdentity(profile);
  const second = await loadOrCreateCamoufoxIdentity(profile);

  assert.equal(draws, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(first.preset, preset);
  assert.equal(first.schema, 1);
  assert.ok(["macos", "windows", "linux"].includes(first.os));

  const stored = JSON.parse(await readFile(camoufoxIdentityPath(profile), "utf8"));
  assert.deepEqual(stored, first);
});

test("invalid persisted identity fails closed instead of silently rotating fingerprint", async t => {
  const root = await mkdtemp(join(tmpdir(), "devos-camoufox-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  await writeFile(camoufoxIdentityPath(profile), "{not-json", "utf8");

  let draws = 0;
  t.mock.method(camoufoxIdentityDeps, "getRandomPreset", () => {
    draws++;
    return { userAgent: "replacement" } as never;
  });

  await assert.rejects(
    loadOrCreateCamoufoxIdentity(profile),
    /refusing to rotate browser identity/,
  );
  assert.equal(draws, 0);
});
