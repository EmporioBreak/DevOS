import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  validateQualityMethodPolicy, verifyQualityMethodSources, qualityMethodsFor,
  assertSafeQualitySelection,
} from "../src/quality-methods.js";
import { parseSkillLibrary } from "../src/skills-library.js";

const policy = validateQualityMethodPolicy(JSON.parse(
  await readFile("config/devos-quality-methods.json", "utf8")));
const catalog = parseSkillLibrary(JSON.parse(
  await readFile("config/devos-skills.json", "utf8")));
const roots = {
  projectRoot: process.cwd(),
  upstreamRoot: join(homedir(), ".devos-staging", "upstream"),
  upstreamPins: { superpowers: "8ca22dba9a94f28898bbce59f2537ff4d87c747d" },
};

test("all four original quality skills are pinned and unchanged", async () => {
  assert.equal(policy.methods.length, 4);
  await verifyQualityMethodSources(policy, catalog, roots);
  assert.deepEqual(qualityMethodsFor(policy, "developer", "implement").map(x => x.id),
    ["test-first"]);
  assert.deepEqual(qualityMethodsFor(policy, "developer", "debug").map(x => x.id),
    ["root-cause"]);
  assert.deepEqual(qualityMethodsFor(policy, "developer", "review-feedback").map(x => x.id),
    ["review-feedback"]);
  assert.deepEqual(qualityMethodsFor(policy, "reviewer", "review").map(x => x.id),
    ["verification"]);
  assert.deepEqual(qualityMethodsFor(policy, "reviewer", "complete").map(x => x.id),
    ["verification"]);
  assert.deepEqual(qualityMethodsFor(policy, "reviewer", "implement"), []);
});

test("requesting-code-review and other competing orchestrator skills fail preflight", () => {
  assertSafeQualitySelection(policy, [
    "superpowers-test-driven-development", "superpowers-systematic-debugging",
  ]);
  for (const denied of policy.neverAutoActivate) {
    assert.throws(() => assertSafeQualitySelection(policy, [denied]),
      /must not self-dispatch/);
  }
  assert.throws(() => assertSafeQualitySelection(policy, [
    "superpowers-test-driven-development", "superpowers-test-driven-development",
  ]), /Duplicate/);
  assert.throws(() => validateQualityMethodPolicy({
    ...policy, neverAutoActivate: policy.neverAutoActivate.slice(1),
  }), /Unsafe skill/);
  assert.throws(() => validateQualityMethodPolicy({
    ...policy, methods: [{ ...policy.methods[0]!, skillId: "superpowers-requesting-code-review" },
      ...policy.methods.slice(1)],
  }), /unapproved skill/);
});

test("real RED to GREEN regression and causal debugging evidence", async () => {
  const spec = "tests/fixtures/quality-methods/query.test.mjs";
  const execute = (module: string) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", spec], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    // Nested node:test processes must not inherit NODE_TEST_CONTEXT from this runner.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      DEVOS_QUALITY_TEST_SOURCE: module,
    },
  });
  const red = execute("buggy.mjs");
  assert.notEqual(red.status, 0, "buggy version must fail regression tests first");
  assert.match(red.stdout + red.stderr, /not ok/);
  const green = execute("fixed.mjs");
  assert.equal(green.status, 0, green.stderr || green.stdout);
  assert.match(green.stdout, /pass 2/);
  const cause = await readFile("tests/fixtures/quality-methods/root-cause.md", "utf8");
  assert.match(cause, /Root cause/);
  assert.match(cause, /Incorrect suggestion/);
  assert.match(cause, /reject it with evidence/);
  console.log("Observed RED: buggy regression fails; GREEN: fixed regression passes 2/2");
});
