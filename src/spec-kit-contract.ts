import { realpath, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const gitFile = promisify(execFile);

export type SpecKitScenario = "feature" | "bugfix" | "assess";
export type SpecKitPhase = "draft" | "approved" | "running" | "converging" | "accepted";

export interface SpecKitArtifactContract {
  version: 1;
  task: { repo: string; issue: number };
  epic?: number;
  scenario: SpecKitScenario;
  phase: SpecKitPhase;
  /** Exact verified Git revision containing the referenced artifacts. */
  commit: string;
  /** Canonical directory under specs/ for the feature or scenario. */
  artifactDirectory: string;
  /** Paths point to the ORIGINAL Spec Kit artifacts, not a second plan. */
  artifacts: Record<string, string>;
  dependsOn: number[];
}

const PREFIX = "<!-- DEVOS_SPECKIT_V1 -->";
const SUFFIX = "<!-- /DEVOS_SPECKIT_V1 -->";
const ALLOWED_ARTIFACT_KEYS = new Set([
  "spec", "plan", "tasks", "research", "dataModel",
  "quickstart", "checklist", "assessment", "fix", "test",
  "intake", "problem", "concept", "decision",
]);

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function safeRelativePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || isAbsolute(value) ||
      value.includes("\\") || value.includes("\0") ||
      value.split("/").some(part => !part || part === "." || part === "..") ||
      !/^[.A-Za-z0-9_-][A-Za-z0-9_.\/-]*$/.test(value))
    throw new Error(`${name}: unsafe relative path`);
  return value;
}

export function validateSpecKitContract(value: unknown): SpecKitArtifactContract {
  const v = record(value, "Spec Kit contract");
  const allowed = new Set([
    "version", "task", "epic", "scenario", "phase",
    "commit", "artifactDirectory", "artifacts", "dependsOn",
  ]);
  if (Object.keys(v).some(k => !allowed.has(k))) throw new Error("Unknown Spec Kit contract fields");
  if (v.version !== 1) throw new Error("Spec Kit contract version must be 1");
  const t = record(v.task, "Spec Kit task");
  if (Object.keys(t).some(k => !["repo", "issue"].includes(k)) ||
      typeof t.repo !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repo) ||
      !Number.isSafeInteger(t.issue) || (t.issue as number) < 1)
    throw new Error("Invalid Spec Kit task reference");
  const scenario = v.scenario;
  const phase = v.phase;
  if (!["feature", "bugfix", "assess"].includes(String(scenario)))
    throw new Error("Unknown Spec Kit scenario");
  if (!["draft", "approved", "running", "converging", "accepted"].includes(String(phase)))
    throw new Error("Unknown Spec Kit phase");
  if (typeof v.commit !== "string" || !/^[0-9a-f]{40}$/.test(v.commit))
    throw new Error("Spec Kit artifacts require an exact Git commit SHA");
  const artifactDirectory = safeRelativePath(v.artifactDirectory, "artifactDirectory");
  const allowedDirectory = scenario === "feature"
    ? /^specs\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/
    : scenario === "bugfix"
      ? /^\.specify\/bugs\/[a-z0-9-]+$/
      : /^\.specify\/assessments\/[a-z0-9-]+$/;
  if (!allowedDirectory.test(artifactDirectory))
    throw new Error("Spec Kit artifact directory is not canonical for scenario");
  const raw = record(v.artifacts, "Spec Kit artifacts");
  if (!Object.keys(raw).length || Object.keys(raw).some(k => !ALLOWED_ARTIFACT_KEYS.has(k)))
    throw new Error("Missing or unknown Spec Kit artifacts");
  const artifacts: Record<string, string> = {};
  for (const [key, path] of Object.entries(raw)) {
    const validated = safeRelativePath(path, key);
    if (!validated.startsWith(artifactDirectory + "/"))
      throw new Error(`Spec Kit artifact must belong to its feature directory: ${key}`);
    artifacts[key] = validated;
  }
  if (scenario === "feature" &&
      (artifacts.spec !== artifactDirectory + "/spec.md" ||
       artifacts.plan !== artifactDirectory + "/plan.md" ||
       artifacts.tasks !== artifactDirectory + "/tasks.md"))
    throw new Error("Feature must link one original Spec Kit spec.md, plan.md, tasks.md");
  if (scenario === "bugfix") {
    const canonical = new Set(["assessment", "fix", "test"]);
    if (Object.keys(artifacts).some(key =>
      !canonical.has(key) || artifacts[key] !== artifactDirectory + "/" + key + ".md"))
      throw new Error("Bugfix must reference original assessment.md, fix.md and test.md");
  }
  if (scenario === "assess") {
    const canonical = new Set(["intake", "research", "problem", "concept", "decision"]);
    if (Object.keys(artifacts).some(key =>
      !canonical.has(key) || artifacts[key] !== artifactDirectory + "/" + key + ".md"))
      throw new Error("Assess must reference original intake/research/problem/concept/decision");
  }
  if (!Array.isArray(v.dependsOn) ||
      v.dependsOn.some(n => !Number.isSafeInteger(n) || n < 1 || n === t.issue) ||
      new Set(v.dependsOn).size !== v.dependsOn.length)
    throw new Error("Invalid, duplicate or self-dependent GitHub Issues");
  if (v.epic !== undefined &&
      (!Number.isSafeInteger(v.epic) || (v.epic as number) < 1))
    throw new Error("Invalid Epic number");
  return {
    version: 1,
    task: { repo: t.repo as string, issue: t.issue as number },
    ...(v.epic !== undefined ? { epic: v.epic as number } : {}),
    scenario: scenario as SpecKitScenario,
    phase: phase as SpecKitPhase,
    commit: v.commit,
    artifactDirectory,
    artifacts,
    dependsOn: [...v.dependsOn] as number[],
  };
}

export function embedSpecKitContract(issueBody: string, contract: SpecKitArtifactContract): string {
  const valid = validateSpecKitContract(contract);
  if (issueBody.includes(PREFIX) || issueBody.includes(SUFFIX))
    throw new Error("Issue already contains Spec Kit contract; update the existing block explicitly");
  return issueBody.trimEnd() + "\n\n" + PREFIX + "\n```json\n" +
    JSON.stringify(valid, null, 2) + "\n```\n" + SUFFIX + "\n";
}

export function parseSpecKitContract(issueBody: string): SpecKitArtifactContract | null {
  const start = issueBody.indexOf(PREFIX);
  const end = issueBody.indexOf(SUFFIX);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start ||
      issueBody.indexOf(PREFIX, start + PREFIX.length) >= 0 ||
      issueBody.indexOf(SUFFIX, end + SUFFIX.length) >= 0)
    throw new Error("Ambiguous or partial Spec Kit issue contract");
  const middle = issueBody.slice(start + PREFIX.length, end).trim();
  const matched = /^\`\`\`json\s*([\s\S]*?)\s*\`\`\`$/.exec(middle);
  if (!matched) throw new Error("Malformed Spec Kit contract JSON code fence");
  let obj: unknown;
  try { obj = JSON.parse(matched[1]!); }
  catch { throw new Error("Malformed Spec Kit contract JSON"); }
  return validateSpecKitContract(obj);
}

/** Prevent both absolute traversal and symlinks escaping the selected worktree. */
export async function verifySpecKitArtifactPaths(root: string, contract: SpecKitArtifactContract):
  Promise<string[]> {
  const valid = validateSpecKitContract(contract);
  const realRoot = await realpath(root);
  const files: string[] = [];
  for (const [name, path] of Object.entries(valid.artifacts)) {
    const full = resolve(realRoot, path);
    const canonical = await realpath(full);
    const diff = relative(realRoot, canonical);
    if (!diff || diff.startsWith(".." + sep) || diff === ".." || isAbsolute(diff))
      throw new Error(`Spec Kit artifact escapes worktree: ${name}`);
    if (!(await stat(canonical)).isFile()) throw new Error(`Not an artifact file: ${name}`);
    files.push(full);
  }
  return files;
}

/** Confirm that GitHub's recorded commit contains exactly the bytes in the worktree.
 * A worktree HEAD may advance without silently changing approved artifacts. */
export async function verifySpecKitArtifactRevision(
  root: string, contract: SpecKitArtifactContract,
): Promise<void> {
  const valid = validateSpecKitContract(contract);
  const files = await verifySpecKitArtifactPaths(root, valid);
  for (const [index, [name, path]] of Object.entries(valid.artifacts).entries()) {
    let committed: Buffer;
    try {
      const output = await gitFile("git", ["-C", root, "show",
        `${valid.commit}:${path}`],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
      committed = output.stdout;
    } catch {
      throw new Error(`Spec Kit artifact not available at pinned revision: ${name}`);
    }
    const current = await readFile(files[index]!);
    if (!current.equals(committed))
      throw new Error(`Spec Kit artifact bytes differ from pinned revision: ${name}`);
  }
}

/** Validate the explicit dependency graph without rejecting already-completed external Issues. */
export function validateSpecKitDependencyGraph(contracts: SpecKitArtifactContract[]): void {
  const byTask = new Map<string, SpecKitArtifactContract>();
  for (const raw of contracts) {
    const contract = validateSpecKitContract(raw);
    const id = `${contract.task.repo}#${contract.task.issue}`;
    if (byTask.has(id)) throw new Error(`Duplicate GitHub Issue contract: ${id}`);
    byTask.set(id, contract);
  }
  const active = new Set<string>();
  const done = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error(`Cyclic GitHub Issue dependency: ${id}`);
    if (done.has(id)) return;
    const contract = byTask.get(id);
    if (!contract) return; // A dependency may be a completed Issue outside this batch.
    active.add(id);
    for (const dependency of contract.dependsOn)
      visit(`${contract.task.repo}#${dependency}`);
    active.delete(id);
    done.add(id);
  }
  for (const id of byTask.keys()) visit(id);
}
