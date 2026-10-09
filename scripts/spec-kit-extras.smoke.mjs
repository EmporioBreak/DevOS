import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, rm, readdir, lstat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectOriginalSpecKitBundle, PINNED_SPEC_KIT_REVISION,
  PINNED_ORIGINAL_BUNDLES } from "../dist/src/spec-kit-extras.js";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamRoot = resolve(process.env.DEVOS_UPSTREAM_ROOT || join(homedir(), ".devos-staging", "upstream"));
const sourceRoot = join(upstreamRoot, "spec-kit");
const expected = JSON.parse(await readFile(join(project, "config/devos-upstreams.lock.json"), "utf8"))
  .sources.find(source => source.id === "spec-kit");
assert.equal(expected.commit, PINNED_SPEC_KIT_REVISION);
function run(bin, argv, cwd = project, allowError = false) {
  const result = spawnSync(bin, argv, {
    cwd, encoding: "utf8", timeout: 65_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, UV_NO_PROGRESS: "1" },
  });
  if (result.error || (!allowError && result.status !== 0))
    throw new Error(`${bin} ${argv.join(" ")} failed (${result.status}): ${String(result.stderr || result.error).slice(-800)}`);
  return result;
}
const specify = (cwd, ...args) => run("uvx", ["--offline", "--from", sourceRoot, "specify", ...args], cwd).stdout;
const json = (cwd, ...args) => JSON.parse(specify(cwd, ...args));
const revision = run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]).stdout.trim();
assert.equal(revision, PINNED_SPEC_KIT_REVISION);
assert.equal(run("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "");
run("node", ["scripts/devos-upstreams.mjs", "verify", "--root", upstreamRoot]);

// Real original introspection in DevOS checkout (not a reimplementation).
const artifactRows = json(project, "artifact", "list", "--json");
assert.ok(Array.isArray(artifactRows) && artifactRows.length >= 19);
const githubCommand = artifactRows.find(row => row.id === "command:speckit.github.taskstoissues");
assert.ok(githubCommand, "manual original GitHub conversion must be discoverable");
const artifactInfo = json(project, "artifact", "info", githubCommand.id, "--json");
assert.equal(artifactInfo.id, githubCommand.id);
const contribution = artifactInfo.stack.find(row => row.lookupId);
assert.ok(contribution?.lookupId);
const lookup = json(project, "artifact", "lookup", contribution.lookupId, "--json");
assert.equal(lookup.id, contribution.lookupId);

const choices = json(project, "bundle", "search", "--offline", "--json");
assert.ok(Array.isArray(choices));
for (const id of Object.keys(PINNED_ORIGINAL_BUNDLES)) {
  const choice = choices.find(item => item.id === id);
  assert.equal(choice?.verified, true);
  assert.equal(choice?.install_policy, "install-allowed");
}

const extensions = await readFile(join(project, ".specify/extensions.yml"), "utf8");
assert.ok(!extensions.includes("command: speckit.github.taskstoissues"));
assert.equal((extensions.match(/  - extension: git\n    command: speckit\.git\.[^\n]+\n    enabled: false/g) || []).length, 18);

const results = [];
for (const id of Object.keys(PINNED_ORIGINAL_BUNDLES)) {
  const manifest = join(sourceRoot, "bundles", id, "bundle.yml");
  assert.ok((await lstat(manifest)).isFile());
  const approvalPlan = inspectOriginalSpecKitBundle(id, await readFile(manifest));
  assert.equal(approvalPlan.requiresOwnerApproval, true);
  assert.equal(approvalPlan.mayStartWorkflowEngine, false);
  assert.equal(approvalPlan.mayActivatePresets, false);
  // Installation is exercised ONLY in disposable fixtures, never in live DevOS.
  const fixture = await mkdtemp(join(tmpdir(), `devos130-${id}-`));
  try {
    specify(fixture, "bundle", "validate", "--path", manifest, "--offline");
    specify(fixture, "bundle", "install", manifest, "--integration", "codex", "--offline");
    const installed = json(fixture, "bundle", "list", "--json");
    assert.equal(installed.length, 1);
    assert.equal(installed[0].bundle_id, id);
    const components = installed[0].contributed_components;
    assert.ok(components.some(c => c.kind === "extensions" && c.id === approvalPlan.extension));
    assert.ok(components.some(c => c.kind === "workflows" && c.id === approvalPlan.workflow));
    assert.ok(components.every(c => c.kind === "extensions" || c.kind === "workflows"));
    assert.ok(!(await readdir(join(fixture, ".specify"))).includes("presets"));
    assert.ok(!(await readdir(fixture)).includes(".git"));
    const beforeEvent = await readdir(fixture);
    const badEvent = run("uvx", ["--offline", "--from", sourceRoot, "specify", "event", "run",
      "devos-nonexistent-handler", "session_start", "1"], fixture, true);
    // Original event CLI treats an unregistered command as a successful no-op.
    assert.equal(badEvent.status, 0, "unregistered event is upstream no-op");
    assert.deepEqual(await readdir(fixture), beforeEvent, "unregistered event cannot write files");
    results.push(`${id}: original offline install/list/validate + event no-op PASS`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ status: "pass", source: "official Spec Kit v1.1.2 pinned Git source",
  artifactInventory: artifactRows.length, bundles: results,
  workflowEngineStarted: false, productionStateMutated: false }));
