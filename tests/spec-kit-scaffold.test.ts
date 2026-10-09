import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const originalSkills = [
  "constitution", "specify", "clarify", "plan", "checklist",
  "tasks", "analyze", "implement", "converge", "taskstoissues",
];

test("official pinned Spec Kit Codex scaffold preserves all core SDD skills", async () => {
  for (const name of originalSkills) {
    const path = join(root, ".agents", "skills", `speckit-${name}`, "SKILL.md");
    const text = await readFile(path, "utf8");
    assert.ok(text.length > 100, `empty ${name} original skill`);
  }
  const install = JSON.parse(await readFile(join(root, ".specify", "integrations", "speckit.manifest.json"), "utf8"));
  assert.equal(install.version, "1.1.2");
  assert.ok(Object.keys(install.files).some(file => file.includes("create-new-feature.sh")));
  await stat(join(root, ".specify", "templates", "plan-template.md"));
});

test("Spec Kit installation does not replace DevOS AGENTS.md or turn on competing Git workflow", async () => {
  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /Main-agent execution boundary/);
  assert.match(agents, /MCP chat authorization: on demand/);
  const init = JSON.parse(await readFile(join(root, ".specify", "init-options.json"), "utf8"));
  assert.equal(init.integration, "codex");
  const helper = await readFile(join(root, ".specify", "scripts", "bash", "create-new-feature.sh"), "utf8");
  assert.doesNotMatch(helper, /git (?:checkout|switch|branch|commit)/);
});
