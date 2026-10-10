import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  parseSkillLibrary, verifySkillFiles, readPinnedSkillResource,
} from "../src/skills-library.js";

const root = {
  projectRoot: process.cwd(),
  upstreamRoot: join(homedir(), ".devos-staging", "upstream"),
  upstreamPins: { superpowers: "8ca22dba9a94f28898bbce59f2537ff4d87c747d" },
};

test("original Superpowers brainstorming remains byte-perfect, adapter lives separately", async () => {
  const catalog = parseSkillLibrary(
    JSON.parse(await readFile("config/devos-skills.json", "utf8")));
  const upstream = catalog.skills.find(skill => skill.id === "superpowers-brainstorming")!;
  const adapted = catalog.skills.find(skill => skill.id === "devos-brainstorming")!;
  assert.equal(catalog.skills.length, 17);
  assert.equal(upstream.source.kind, "upstream");
  assert.equal(adapted.source.kind, "adapted");
  assert.equal(adapted.source.derivedFrom, "superpowers-brainstorming@6.4.2");
  assert.deepEqual(adapted.conflicts, ["superpowers-brainstorming"]);
  await verifySkillFiles(upstream, root);
  await verifySkillFiles(adapted, root);
  assert.notEqual(adapted.files["SKILL.md"], upstream.files["SKILL.md"]);
  const bytes = await readPinnedSkillResource(upstream, "SKILL.md", root);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "a32d2255354775aa124855aa7100cf276bea096fff4ebb3a0edf57be216e6c72");
});

test("approval gates are predevelopment-only and don't repeat approved worker consent", async () => {
  const content = await readFile("skills/devos-brainstorming/SKILL.md", "utf8");
  for (const expected of ["Discover intent", "Spike", "Bounded", "Architectural",
    "HARD GATE", "owner-approved", "User", "predevelopment",
    "Git SHA", "DevOS Main Agent", "DevOS Runner",
    "Constitution", "Spec Kit", "T-step"]) {
    assert.ok(content.toLowerCase().includes(expected.toLowerCase()),
      `missing important brainstorming constraint: ${expected}`);
  }
  assert.match(content, /Never[\s\S]*silence as consent/i);
  assert.match(content, /No duplicated approvals/);
  assert.match(content, /new material scope/i);
  assert.match(content, /original.*speckit-specify/i);
  for (const forbidden of [
    "docs/superpowers/specs/YYYY-MM-DD", "Invoke the writing-plans skill",
    "start the server with `--open`", "git commit", "subagent-driven-development",
  ]) assert.ok(!content.includes(forbidden), `unwanted upstream control: ${forbidden}`);
  assert.match(content, /Only DevOS Runner executes the frozen worker graph/);
});

test("fixture describes explicit architectural approval and bounded reuse without inventing consent", async () => {
  const fixture = await readFile("tests/fixtures/devos-brainstorming/approval-cases.md", "utf8");
  assert.match(fixture, /Architectural path/);
  assert.match(fixture, /Bounded path/);
  assert.match(fixture, /Spike path/);
  assert.match(fixture, /approval provenance/);
  assert.match(fixture, /needs owner review/);
  assert.match(fixture, /do not request again/);
  assert.match(fixture, /no permission inferred/i);
});
