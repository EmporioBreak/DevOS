import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectOriginalSpecKitBundle, PINNED_ORIGINAL_BUNDLES,
  PINNED_SPEC_KIT_REVISION } from "../src/spec-kit-extras.js";

const root = process.cwd();
const file = (path: string) => readFile(join(root, path), "utf8");

test("original Spec Kit S03 rejects unknown, mutated and unreviewed bundle content", () => {
  for (const id of ["../bugfix", "developer", "bugfix/../../bad", "presets", "__proto__", "constructor"]) {
    assert.throws(() => inspectOriginalSpecKitBundle(id, Buffer.from("anything")), /Unknown|non-reviewed/);
  }
  for (const id of ["bugfix", "assess"]) {
    assert.throws(() => inspectOriginalSpecKitBundle(id, Buffer.from("fake bundle")), /SHA-256 mismatch/);
  }
  assert.match(PINNED_SPEC_KIT_REVISION, /^[0-9a-f]{40}$/);
  for (const record of Object.values(PINNED_ORIGINAL_BUNDLES)) {
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
  }
});

test("existing manual GitHub conversion cannot be triggered by Spec Kit event hooks", async () => {
  const extensions = await file(".specify/extensions.yml");
  assert.doesNotMatch(extensions, /command: speckit\.github\.taskstoissues/);
  const skill = await file(".agents/skills/speckit-github-taskstoissues/SKILL.md");
  assert.match(skill, /GitHub/);
  const gitHooks = extensions.match(/  - extension: git\n    command: speckit\.git\.[^\n]+\n    enabled: (true|false)/g) ?? [];
  assert.equal(gitHooks.length, 18);
  assert.ok(gitHooks.every(block => block.endsWith("enabled: false")));
});

test("original bundle contract never becomes a second Runner or implicit permission", () => {
  const code = String(inspectOriginalSpecKitBundle);
  assert.doesNotMatch(code, /spawnSync|execFileSync|workflow run|taskstoissues/i);
  for (const id of Object.keys(PINNED_ORIGINAL_BUNDLES)) {
    // An exact positive upstream byte test is provided by the host-only smoke,
    // never a fake fixture with an attacker-provided 'verified' flag.
    assert.ok(PINNED_ORIGINAL_BUNDLES[id as keyof typeof PINNED_ORIGINAL_BUNDLES].workflow);
  }
});
