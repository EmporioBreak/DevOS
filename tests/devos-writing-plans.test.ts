import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseSkillLibrary, verifySkillFiles, readPinnedSkillResource } from "../src/skills-library.js";

const upstreamRoot = join(homedir(), ".devos-staging", "upstream");
const originalRevision = "8ca22dba9a94f28898bbce59f2537ff4d87c747d";
const roots = {
  upstreamRoot, projectRoot: process.cwd(),
  upstreamPins: { superpowers: originalRevision },
};

test("original and devos-writing-plans have separate trusted provenance and hashes", async () => {
  const registry = parseSkillLibrary(
    JSON.parse(await readFile("config/devos-skills.json", "utf8")));
  const vendor = registry.skills.find(s => s.id === "superpowers-writing-plans")!;
  const adapted = registry.skills.find(s => s.id === "devos-writing-plans")!;
  assert.equal(registry.skills.length, 17);
  assert.equal(vendor.source.kind, "upstream");
  assert.equal(vendor.source.commit, originalRevision);
  assert.equal(adapted.source.kind, "adapted");
  assert.equal(adapted.source.derivedFrom, "superpowers-writing-plans@6.4.2");
  assert.deepEqual(adapted.conflicts, ["superpowers-writing-plans"]);
  await verifySkillFiles(vendor, roots);
  await verifySkillFiles(adapted, roots);
  assert.notEqual(adapted.files["SKILL.md"], vendor.files["SKILL.md"]);
  const bytes = await readPinnedSkillResource(vendor, "SKILL.md", roots);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "a6c67c1900064347c2a329990dd3c555657c51c3ec53b259a08aa01a2c26139a");
});

test("adapter keeps detailed planning quality while forbidding duplicate orchestration", async () => {
  const skill = await readFile("skills/devos-writing-plans/SKILL.md", "utf8");
  for (const detail of ["Spec Kit", "plan.md", "tasks.md", "T001",
    "Constitution Check", "Interfaces", "RED-GREEN-REFACTOR", "DRY", "YAGNI",
    "Review Focus", "Self-Review"]) {
    assert.ok(skill.includes(detail), `missing planning quality term ${detail}`);
  }
  for (const forbidden of ["superpowers:subagent-driven-development",
    "superpowers:executing-plans", "superpowers:using-git-worktrees",
    "docs/superpowers/plans/", "git commit -m", "Subagent-driven chosen",
    "Which execution approach would you prefer?"]) {
    assert.ok(!skill.includes(forbidden), `conflicting original directive ${forbidden}`);
  }
  assert.match(skill, /same task.*same.*Issue|single.*Issue/i);
  assert.match(skill, /already approved/i);
  assert.match(skill, /DevOS Runner alone coordinates workers/);
});

test("test fixture includes exactly the original three SDD artifacts with precise test-first steps", async () => {
  const root = "tests/fixtures/devos-writing-plans/specs/001-search";
  assert.deepEqual((await readdir(root)).sort(), ["plan.md", "spec.md", "tasks.md"]);
  const [spec, plan, tasks] = await Promise.all(
    ["spec.md", "plan.md", "tasks.md"].map(name => readFile(join(root, name), "utf8")));
  assert.ok(spec && plan && tasks);
  assert.match(spec, /Success Criteria/);
  assert.match(plan, /^# Implementation Plan:/);
  assert.match(plan, /Constitution Check/);
  assert.match(plan, /src\/search\.service\.ts/);
  assert.match(plan, /Review Focus/);
  assert.match(tasks, /^# Tasks:/);
  const steps = [...tasks.matchAll(/^- \[ \] T(\d{3})/gm)].map(match => Number(match[1]));
  assert.deepEqual(steps, [1, 2, 3, 4]);
  assert.match(tasks, /RED:[\s\S]*expect FAIL/);
  assert.match(tasks, /GREEN:[\s\S]*expect PASS/);
  assert.match(tasks, /REFACTOR:[\s\S]*expect PASS/);
  assert.match(tasks, /search\(query: string\): SearchResult\[\]/);
});
