import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const base = process.cwd();
const source = async (name: string) => readFile(join(base, name), "utf8");

test("all 18 original Spec Kit Git hooks are disabled, manual commands preserved", async () => {
  const yaml = await source(".specify/extensions.yml");
  const gitBlocks = yaml.match(/  - extension: git\n    command: speckit\.git\.[^\n]+\n    enabled: (?:true|false)/g) ?? [];
  assert.equal(gitBlocks.length, 18);
  assert.ok(gitBlocks.every(block => block.endsWith("enabled: false")));
  assert.match(yaml, /before_constitution:\n  - extension: git\n    command: speckit\.git\.initialize\n    enabled: false/);
  assert.match(yaml, /before_specify:\n  - extension: git\n    command: speckit\.git\.feature\n    enabled: false/);
  const config = await source(".specify/extensions/git/git-config.yml");
  assert.match(config, /auto_commit:\n  default: false/);
  assert.doesNotMatch(config, /enabled: true/);
  for (const command of ["initialize", "feature", "commit", "remote", "validate"])
    assert.match(await source(`.agents/skills/speckit-git-${command}/SKILL.md`), /speckit/);
});

test("agent-context targets only managed AGENTS.md markers; owner contract preserved", async () => {
  const config = await source(".specify/extensions/agent-context/agent-context-config.yml");
  assert.match(config, /context_files:\n  - AGENTS\.md/);
  assert.match(config, /start: "<!-- SPECKIT START -->"/);
  assert.match(config, /end: "<!-- SPECKIT END -->"/);
  const agents = await source("AGENTS.md");
  assert.match(agents, /Main-agent execution boundary/);
  assert.match(agents, /MCP chat authorization: on demand/);
  assert.doesNotMatch(agents, /<!-- SPECKIT START -->/);
  assert.match(await source(".agents/skills/speckit-agent-context-update/SKILL.md"), /SPECKIT/);
});

test("GitHub taskstoissues exists but is not an automatic hook", async () => {
  const hooks = await source(".specify/extensions.yml");
  assert.doesNotMatch(hooks, /command: speckit\.github\.taskstoissues/);
  assert.match(await source(".agents/skills/speckit-github-taskstoissues/SKILL.md"), /GitHub/);
});

import { mkdtemp, mkdir, cp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

test("two isolated task worktrees update only their own AGENTS.md context", async () => {
  const updater = join(base, ".specify", "extensions", "agent-context",
    "scripts", "python", "update_agent_context.py");
  const roots: string[] = [];
  try {
    for (const issue of [205, 206]) {
      const project = await mkdtemp(join(tmpdir(), `speckit-task-${issue}-`));
      roots.push(project);
      const contextDir = join(project, ".specify", "extensions", "agent-context");
      await mkdir(contextDir, { recursive: true });
      await cp(join(base, "AGENTS.md"), join(project, "AGENTS.md"));
      await cp(join(base, ".specify", "extensions", "agent-context",
        "agent-context-config.yml"), join(contextDir, "agent-context-config.yml"));
      const path = `specs/${issue}-isolated/plan.md`;
      await mkdir(join(project, "specs", `${issue}-isolated`), { recursive: true });
      await writeFile(join(project, path), "Plan for an independent task");
      execFileSync("python3", [updater, path], { cwd: project, encoding: "utf8" });
    }
    const contexts = await Promise.all(roots.map(project =>
      readFile(join(project, "AGENTS.md"), "utf8")));
    for (const [i, content] of contexts.entries()) {
      const issue = 205 + i;
      assert.match(content, /Main-agent execution boundary/);
      assert.equal(content.match(/<!-- SPECKIT START -->/g)?.length, 1);
      assert.equal(content.match(/<!-- SPECKIT END -->/g)?.length, 1);
      assert.ok(content.includes(`specs/${issue}-isolated/plan.md`));
      assert.ok(!content.includes(`specs/${issue === 205 ? 206 : 205}-isolated/plan.md`));
      await assert.rejects(access(join(roots[i]!, ".specify", "feature.json")));
    }
  } finally {
    await Promise.all(roots.map(project => rm(project, { recursive: true, force: true })));
  }
});