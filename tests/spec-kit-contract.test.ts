import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { embedSpecKitContract, parseSpecKitContract, validateSpecKitContract,
  verifySpecKitArtifactPaths, verifySpecKitArtifactRevision, validateSpecKitDependencyGraph,
  type SpecKitArtifactContract } from "../src/spec-kit-contract.js";

const revision = "a".repeat(40);
const issue = (number: number, dependsOn: number[] = []): SpecKitArtifactContract => ({
  version: 1,
  task: { repo: "EmporioBreak/DevOS", issue: number },
  epic: 121, scenario: "feature", phase: "approved", commit: revision,
  artifactDirectory: `specs/issue-${number}/feature`,
  artifacts: {
    spec: `specs/issue-${number}/feature/spec.md`,
    plan: `specs/issue-${number}/feature/plan.md`,
    tasks: `specs/issue-${number}/feature/tasks.md`,
  }, dependsOn,
});

test("two GitHub Issues map to distinct canonical Spec Kit plans and dependencies", () => {
  const a = issue(201), b = issue(202, [201]);
  const aBody = embedSpecKitContract("Implementation task #201", a);
  const bBody = embedSpecKitContract("Implementation task #202", b);
  assert.deepEqual(parseSpecKitContract(aBody), a);
  assert.deepEqual(parseSpecKitContract(bBody), b);
  assert.equal(parseSpecKitContract("No Spec Kit artifact block"), null);
  assert.notEqual(a.artifacts.plan, b.artifacts.plan);
  assert.deepEqual(parseSpecKitContract(bBody)?.dependsOn, [201]);
  assert.throws(() => embedSpecKitContract(aBody, a), /already contains/);
  assert.throws(() => parseSpecKitContract(bBody + bBody), /Ambiguous/);
});

test("rejects divergent plans, unknown fields, self-dependencies and unsafe paths", () => {
  const good = issue(204);
  assert.throws(() => validateSpecKitContract({ ...good, commit: "main" }), /commit SHA/);
  assert.throws(() => validateSpecKitContract({ ...good, dependsOn: [204] }), /self-dependent/);
  assert.throws(() => validateSpecKitContract({ ...good, dependsOn: [20, 20] }), /duplicate/);
  assert.throws(() => validateSpecKitContract({ ...good, extra: true }), /Unknown/);
  assert.throws(() => validateSpecKitContract({ ...good,
    artifacts: { ...good.artifacts, plan: "docs/superpowers/plans/other.md" },
  }), /feature directory/);
  assert.throws(() => validateSpecKitContract({ ...good,
    artifacts: { ...good.artifacts, plan: "specs/issue-204/feature/../../etc/passwd" },
  }), /unsafe relative/);
  assert.throws(() => validateSpecKitContract({ ...good,
    artifacts: { ...good.artifacts, tasks: "specs/issue-204/feature/other.md" },
  }), /one original Spec Kit/);
  assert.throws(() => parseSpecKitContract("<!-- DEVOS_SPECKIT_V1 -->"), /Ambiguous/);
});

test("original Bugfix and Assess scenarios link their own canonical artifacts", () => {
  for (const scenario of ["bugfix", "assess"] as const) {
    const directory = scenario === "bugfix"
      ? ".specify/bugs/callback-token" : ".specify/assessments/offline-mode";
    const contract = { ...issue(210), scenario, phase: "draft" as const,
      artifactDirectory: directory,
      artifacts: scenario === "bugfix"
        ? { assessment: directory + "/assessment.md", fix: directory + "/fix.md",
            test: directory + "/test.md" }
        : { intake: directory + "/intake.md", problem: directory + "/problem.md",
            decision: directory + "/decision.md" },
    };
    assert.deepEqual(parseSpecKitContract(embedSpecKitContract("Request", contract))?.artifacts,
      contract.artifacts);
  }
});

test("real artifact files stay inside their assigned worktree, including symlink guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-speckit-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "devos-speckit-outside-"));
  const spec = issue(211);
  try {
    const dir = join(root, spec.artifactDirectory);
    await mkdir(dir, { recursive: true });
    for (const file of Object.values(spec.artifacts)) await writeFile(join(root, file), "Valid");
    assert.equal((await verifySpecKitArtifactPaths(root, spec)).length, 3);
    await rm(join(dir, "tasks.md"));
    await writeFile(join(outside, "secret.md"), "External file");
    await symlink(join(outside, "secret.md"), join(dir, "tasks.md"));
    await assert.rejects(verifySpecKitArtifactPaths(root, spec), /escapes worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("approved artifact version is verified byte-for-byte against the pinned Git SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-spec-version-"));
  const contract = issue(215);
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args],
      { encoding: "utf8" }).trim();
    git("init", "-q");
    await mkdir(join(root, contract.artifactDirectory), { recursive: true });
    for (const path of Object.values(contract.artifacts)) await writeFile(join(root, path), "Original");
    git("add", "specs");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-qm", "canonical feature artifacts");
    const current = { ...contract, commit: git("rev-parse", "HEAD") };
    await verifySpecKitArtifactRevision(root, current);
    await writeFile(join(root, contract.artifacts.plan!), "Divergent plan");
    await assert.rejects(verifySpecKitArtifactRevision(root, current), /bytes differ/);
    await assert.rejects(verifySpecKitArtifactRevision(root, contract), /not available/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Epic cannot contain cyclic or duplicate task contracts", () => {
  const first = issue(301, [302]);
  const second = issue(302, [303]);
  const third = issue(303, []);
  validateSpecKitDependencyGraph([first, second, third]);
  assert.throws(() => validateSpecKitDependencyGraph([first, second,
    issue(303, [301])]), /Cyclic GitHub Issue dependency/);
  assert.throws(() => validateSpecKitDependencyGraph([first, first]),
    /Duplicate GitHub Issue contract/);
  validateSpecKitDependencyGraph([issue(304, [1])]); // External closed dependency is valid.
});
