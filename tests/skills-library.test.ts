import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, cp, mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseSkillLibrary, snapshotSkillDirectory, verifySkillFiles,
  readPinnedSkillResource, listSkillAvailability, registerSkill,
  previewSkillUpdate, applyReviewedSkillUpdate,
  type SkillDefinition, type SkillLibrary, type SkillRoots,
} from "../src/skills-library.js";

const catalog: SkillLibrary = JSON.parse(
  await readFile("config/devos-skills.json", "utf8"));
const originalCommit = "8ca22dba9a94f28898bbce59f2537ff4d87c747d";
const roots: SkillRoots = {
  projectRoot: process.cwd(),
  upstreamRoot: join(homedir(), ".devos-staging", "upstream"),
  upstreamPins: { superpowers: originalCommit },
};
const baseSkill = () => structuredClone(catalog.skills.find(
  skill => skill.id === "superpowers-brainstorming")!);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

test("catalog contains all 15 original Superpowers skills with SHA-pinned resources", async () => {
  const verified = parseSkillLibrary(catalog);
  assert.equal(verified.skills.length, 16);
  const entries = await listSkillAvailability(verified, roots);
  assert.equal(entries.filter(x => x.status === "installed").length, 16);
  const originals = verified.skills.filter(x => x.source.kind === "upstream");
  assert.equal(originals.length, 15);
  for (const skill of originals) {
    assert.equal(skill.source.kind, "upstream");
    assert.equal(skill.source.license, "MIT");
    assert.equal(skill.source.commit, originalCommit);
    assert.match(skill.source.sourceUrl, /^https:\/\/github\.com\/obra\/superpowers\/tree\//);
    assert.ok(Object.keys(skill.files).includes("SKILL.md"));
    const location = await verifySkillFiles(skill, roots);
    assert.deepEqual(await snapshotSkillDirectory(location), skill.files);
    assert.match((await readPinnedSkillResource(skill, "SKILL.md", roots))
      .toString("utf8"), /\S+/);
  }
  assert.ok(verified.skills.reduce((n, x) => n + Object.keys(x.files).length, 0) >= 70);
});

test("catalog supports no skills and multiple independent user-installed skills", () => {
  let lib = parseSkillLibrary({ version: 1, skills: [] });
  assert.deepEqual(lib.skills, []);
  const a = baseSkill();
  a.id = "first-skill";
  a.version = "1.0.0";
  a.source = {
    kind: "adapted", directory: "skills/devos-first",
    derivedFrom: "superpowers-brainstorming@6.4.2",
    license: "MIT", sourceUrl: "https://github.com/EmporioBreak/DevOS",
  };
  const b = structuredClone(a);
  b.id = "second-skill";
  b.source.directory = "skills/devos-second";
  b.requires = ["first-skill"];
  lib = registerSkill(lib, a);
  lib = registerSkill(lib, b);
  assert.equal(lib.skills.length, 2);
  assert.throws(() => registerSkill(lib, b), /already registered/);
  assert.throws(() => parseSkillLibrary({ version: 1, skills: [{ ...a, requires: ["second-skill"] }, b] }), /Cyclic/);
  assert.throws(() => parseSkillLibrary({ version: 1, skills: [b] }), /Missing required/);
});

test("changed SKILL.md and changed reference both fail closed; source remains unmodified", async () => {
  const temp = await mkdtemp(join(tmpdir(), "devos-skills-fixture-"));
  const original = join(roots.upstreamRoot, "superpowers", "skills", "brainstorming");
  const copy = join(temp, "superpowers", "skills", "brainstorming");
  const isolatedRoots = { ...roots, upstreamRoot: temp };
  const skill = baseSkill();
  try {
    await mkdir(join(temp, "superpowers", "skills"), { recursive: true });
    await cp(original, copy, { recursive: true });
    await verifySkillFiles(skill, isolatedRoots);
    const file = join(copy, "SKILL.md");
    await writeFile(file, "tampered");
    await assert.rejects(verifySkillFiles(skill, isolatedRoots), /integrity/);
    await copyFile(join(original, "SKILL.md"), file);
    await verifySkillFiles(skill, isolatedRoots);
    const ref = Object.keys(skill.files).find(p => p !== "SKILL.md")!;
    await writeFile(join(copy, ref), "altered supporting resource");
    await assert.rejects(verifySkillFiles(skill, isolatedRoots), /integrity/);
    await assert.rejects(readPinnedSkillResource(skill, ref, isolatedRoots), /integrity/);
    await assert.rejects(readPinnedSkillResource(skill, "../secret", isolatedRoots), /unsafe/);
    await assert.rejects(readPinnedSkillResource(skill, "not-declared.md", isolatedRoots), /not declared/);
    await writeFile(join(copy, "unexpected.md"), "not in manifest");
    await assert.rejects(verifySkillFiles(skill, isolatedRoots), /integrity/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("adapted skill cannot pretend its bytes or source identity are original", () => {
  const original = baseSkill();
  const adapted = structuredClone(original);
  adapted.id = "devos-brainstorming";
  adapted.version = "1.0.0";
  adapted.source = {
    kind: "adapted", directory: "skills/devos-brainstorming",
    derivedFrom: "superpowers-brainstorming@6.4.2",
    license: "MIT", sourceUrl: "https://github.com/EmporioBreak/DevOS",
  };
  parseSkillLibrary({ version: 1, skills: [original, adapted] });
  assert.throws(() => parseSkillLibrary({ version: 1, skills: [
    { ...adapted, source: { ...adapted.source, commit: originalCommit } },
  ] }), /must stay separate/);
  assert.throws(() => parseSkillLibrary({ version: 1, skills: [
    { ...adapted, source: { ...adapted.source, derivedFrom: "" } },
  ] }), /must stay separate/);
  assert.throws(() => parseSkillLibrary({ version: 1, skills: [
    { ...original, source: { ...original.source, derivedFrom: "adapted" } },
  ] }), /pinned upstream commit/);
});

test("version update preview detects changed assets and blocks silent same-version edits/downgrades", () => {
  const old = baseSkill(), next = structuredClone(old);
  next.version = "6.4.3";
  const reference = Object.keys(next.files).find(p => p !== "SKILL.md")!;
  next.files[reference] = hash("changed fixture");
  next.files["new-reference.md"] = hash("new fixture");
  delete next.files["SKILL.md"];
  assert.throws(() => previewSkillUpdate(old, next), /no complete SKILL.md/);
  next.files["SKILL.md"] = old.files["SKILL.md"]!;
  const diff = previewSkillUpdate(old, next);
  assert.deepEqual(diff.added, ["new-reference.md"]);
  assert.deepEqual(diff.changed, [reference]);
  assert.throws(() => previewSkillUpdate(old, { ...next, version: old.version }), /version bump/);
  assert.throws(() => previewSkillUpdate(old, { ...next, version: "6.4.1" }), /downgrade/);
  assert.deepEqual(previewSkillUpdate(old, old).changed, []);
});

test("incorrect upstream revision refuses to load required originals", async () => {
  const skill = baseSkill();
  await assert.rejects(verifySkillFiles(skill, { ...roots, upstreamPins: {
    superpowers: "f".repeat(40),
  } }), /revision/);
});


test("updating a skill requires the exact reviewed before/after fingerprint", () => {
  const old = baseSkill();
  const next = structuredClone(old);
  next.version = "6.5.0";
  next.files["SKILL.md"] = hash("new version");
  const starting: SkillLibrary = { version: 1, skills: [old] };
  const preview = previewSkillUpdate(old, next);
  assert.match(preview.reviewFingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.changed, ["SKILL.md"]);
  assert.throws(
    () => applyReviewedSkillUpdate(starting, next, "a".repeat(64)),
    /does not match approved/,
  );
  const swapped = structuredClone(next);
  swapped.files["SKILL.md"] = hash("unreviewed injection");
  assert.throws(
    () => applyReviewedSkillUpdate(starting, swapped, preview.reviewFingerprint),
    /does not match approved/,
  );
  const result = applyReviewedSkillUpdate(starting, next, preview.reviewFingerprint);
  assert.equal(result.skills[0]?.version, "6.5.0");
  assert.equal(starting.skills[0]?.version, "6.4.2", "original registry was not mutated");
  assert.throws(() => applyReviewedSkillUpdate(result, next, preview.reviewFingerprint),
    /new version/);
});

test("independent adapted bytes do not affect immutable upstream hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-adapted-skill-"));
  const source = baseSkill();
  const directory = join(root, "skills", "devos-brainstorming");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"),
      "# DevOS brainstorming\nNo duplicate approver or runner.\n");
    await writeFile(join(directory, "references.md"),
      "# One canonical original Spec Kit plan\n");
    const adapted: SkillDefinition = {
      ...structuredClone(source), id: "devos-brainstorming", version: "1.0.0",
      source: {
        kind: "adapted", directory: "skills/devos-brainstorming",
        derivedFrom: "superpowers-brainstorming@6.4.2",
        license: "MIT", sourceUrl: "https://github.com/EmporioBreak/DevOS",
      },
      files: await snapshotSkillDirectory(directory),
    };
    const testRoots = { ...roots, projectRoot: root };
    await verifySkillFiles(adapted, testRoots);
    await verifySkillFiles(source, roots);
    assert.notEqual(adapted.files["SKILL.md"], source.files["SKILL.md"]);
    const combined = registerSkill(catalog, adapted);
    assert.equal(combined.skills.length, 17);
    assert.equal(combined.skills.find(x => x.id === source.id)?.files["SKILL.md"],
      source.files["SKILL.md"]);
    await writeFile(join(directory, "references.md"), "tampered");
    await assert.rejects(verifySkillFiles(adapted, testRoots), /integrity/);
    await verifySkillFiles(source, roots);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
