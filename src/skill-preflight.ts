import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, relative, isAbsolute } from "node:path";
import { parseSkillLibrary, verifySkillFiles, readPinnedSkillResource,
  type SkillLibrary, type SkillRoots } from "./skills-library.js";
import { assertSafeQualitySelection, validateQualityMethodPolicy,
  type QualityMethodPolicy } from "./quality-methods.js";

export type SkillExecutionPhase = "planning" | "execution";
export interface SkillSelection {
  id: string;
  /** Exact version frozen before Runner starts. */
  version: string;
}
export interface SkillPreflightRequest {
  phase: SkillExecutionPhase;
  /** Authority assigned by Main Agent, never proof of MCP chat authorization. */
  role: string;
  selected: SkillSelection[];
  /** Required IDs must be explicitly included in selected, never silently injected. */
  required: string[];
  off: string[];
  /** Original immutable Spec Kit SDD instruction that this stage requires. */
  /** Explicit null means pre-SDD brainstorming or standalone independent review;
   * omitted/undefined is not a valid preflight contract. */
  specKitStage: string | null;
}
export interface OriginalSpecKitPin {
  skillId: string;
  path: string;
  sha256: string;
}
export interface SpecKitStagePins {
  version: 1;
  upstream: "github/spec-kit";
  release: string;
  stages: Record<string, OriginalSpecKitPin>;
}
export interface SkillPreflightOptions {
  library: SkillLibrary;
  roots: SkillRoots;
  qualityPolicy: QualityMethodPolicy;
  stagePins: SpecKitStagePins;
}
export interface SkillPreflightResult {
  role: string;
  phase: SkillExecutionPhase;
  specKitStage?: string;
  stageSkillId?: string;
  /** Already checked exact versions and hashes; safe to freeze in worker manifest. */
  skills: SkillSelection[];
}
const DENIED_ORIGINALS: Record<string,string> = {
  "superpowers-brainstorming":"devos-brainstorming",
  "superpowers-writing-plans":"devos-writing-plans",
  "superpowers-using-superpowers":"Use DevOS Main Agent explicit skill selection",
  "superpowers-writing-skills":"Use reviewed Skills Library registration and update",
  "superpowers-diagnosing-superpowers":"Use DevOS skill preflight diagnostics",
};
const SAFE_UPSTREAM_SUPERPOWERS = new Set([
  "superpowers-test-driven-development",
  "superpowers-systematic-debugging",
  "superpowers-receiving-code-review",
  "superpowers-verification-before-completion",
]);
const ROLES = new Set(["main_agent", "developer", "reviewer", "qa", "auditor"]);

/** Defense-in-depth only: explicit runnable conflicting directives in a new skill.
 * No text scanner proves arbitrary skills safe; registered reviews are required. */
export function findConflictingSkillDirective(content: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s*/, "").replace(/^\*\*/, "");
    // Negative examples and safety warnings are not executable directives.
    if (/^(?:never|do not|don't|avoid|forbid|prohibit|must not|no\s+)/i.test(line))
      continue;
    if (/^(?:git\s+(?:switch|checkout|commit|merge|branch)|(?:run|execute|invoke)\s+\S*speckit\s+workflow\s+run)/i.test(line))
      return line.slice(0, 140);
    if (/^(?:dispatch|spawn|launch|create|invoke|start|run|use)\s+(?:a\s+|an\s+|the\s+|new\s+)*[^.\n]{0,90}\b(?:subagent|independent\s+agent|separate\s+workflow\s+engine|git\s+worktree|own\s+reviewer)\b/i.test(line))
      return line.slice(0, 140);
    if (/^(?:dispatch|spawn|launch|create|invoke|start|run|use)\s+superpowers:(?:subagent-driven-development|executing-plans|using-git-worktrees|finishing-a-development-branch)/i.test(line))
      return line.slice(0, 140);
  }
  return null;
}

const STAGE_NAMES = new Set(["constitution","specify","clarify","plan",
  "checklist","tasks","analyze","implement","converge"]);
const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function deny(message: string, suggestion?: string): never {
  throw new Error("Skill preflight blocked: " + message +
    (suggestion ? ". Alternative: " + suggestion : ""));
}
function validateNames(names: string[], label: string): void {
  if (!Array.isArray(names) || names.some(x => typeof x !== "string" || !kebab.test(x)))
    deny("invalid " + label + " skill IDs");
  if (new Set(names).size !== names.length) deny("duplicate " + label + " skill IDs");
}
async function validateStage(
  name: string, pin: SpecKitStagePins, root: string,
): Promise<OriginalSpecKitPin> {
  if (!STAGE_NAMES.has(name)) deny("unknown original Spec Kit stage " + name);
  if (!pin || pin.version !== 1 || pin.upstream !== "github/spec-kit" ||
      pin.release !== "v1.1.2")
    deny("unsupported original Spec Kit pin set");
  if (Object.keys(pin.stages).length !== STAGE_NAMES.size ||
      [...STAGE_NAMES].some(x => !pin.stages[x])) deny("missing mandatory original Spec Kit stage");
  const item = pin.stages[name]!;
  const expected = ".agents/skills/speckit-" + name + "/SKILL.md";
  if (item.skillId !== "speckit-" + name || item.path !== expected ||
      !/^[0-9a-f]{64}$/.test(item.sha256))
    deny("invalid original Spec Kit stage pin: " + name);
  const canonicalRoot = await realpath(root);
  const actualPath = await realpath(resolve(canonicalRoot, expected));
  const rel = relative(canonicalRoot, actualPath);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    deny("original Spec Kit stage path escapes project");
  const digest = createHash("sha256").update(await readFile(actualPath)).digest("hex");
  if (digest !== item.sha256)
    deny("original Spec Kit " + name + " instructions differ from pinned release");
  return item;
}

/**
 * Main Agent pre-run safety gate. It does NOT authorize MCP tools, grant workers,
 * add roles or mutate the graph; those require separate trusted server checks.
 */
export async function preflightSkills(
  input: SkillPreflightRequest, options: SkillPreflightOptions,
): Promise<SkillPreflightResult> {
  if (!input || !["planning","execution"].includes(input.phase) ||
      !ROLES.has(input.role))
    deny("invalid phase or declared worker role");
  if (!Object.prototype.hasOwnProperty.call(input, "specKitStage") ||
      input.specKitStage === undefined)
    deny("original Spec Kit stage must be explicit; use null only for pre-SDD or standalone review");
  if (input.specKitStage === null &&
      (input.phase === "execution" && input.role === "developer" ||
       input.selected.some(x => x.id === "devos-writing-plans")))
    deny("mandatory Spec Kit stage cannot be skipped for an implementer or Spec Kit planning");
  if (!Array.isArray(input.selected) ||
      input.selected.some(x => !x || typeof x.id !== "string" ||
        !kebab.test(x.id) || typeof x.version !== "string" || !x.version))
    deny("invalid or unpinned selected skills");
  const selected = input.selected.map(x => x.id);
  validateNames(selected, "selected");
  validateNames(input.required, "required");
  validateNames(input.off, "off");
  const off = new Set(input.off), selectedIds = new Set(selected);
  if (input.required.some(x => off.has(x)))
    deny("required skill is explicitly off: " + input.required.find(x => off.has(x)));
  if (selected.some(x => off.has(x)))
    deny("disabled skill was selected: " + selected.find(x => off.has(x)));
  if (input.required.some(x => !selectedIds.has(x)))
    deny("mandatory skill omitted: " + input.required.find(x => !selectedIds.has(x)),
      "Assign it explicitly or return to Main Agent to change the requirement");
  const quality = validateQualityMethodPolicy(options.qualityPolicy);
  try { assertSafeQualitySelection(quality, selected); }
  catch (error) { deny(String((error as Error).message),
    "Use the predeclared DevOS reviewer/worker graph instead"); }
  const lib = parseSkillLibrary(options.library);
  const byId = new Map(lib.skills.map(x => [x.id,x]));
  for (const ref of input.selected) {
    const skill = byId.get(ref.id);
    if (!skill) deny("skill is not in reviewed registry: " + ref.id);
    if (skill.version !== ref.version)
      deny("pinned skill version mismatch for " + ref.id +
        ": selected " + ref.version + ", registry " + skill.version);
    if (skill.source.kind === "upstream" &&
        skill.source.upstreamId === "superpowers" &&
        !SAFE_UPSTREAM_SUPERPOWERS.has(ref.id))
      deny("original " + ref.id + " requires DevOS compatibility review",
        DENIED_ORIGINALS[ref.id] ?? "Select an explicitly approved adapted skill");
    if (ref.id === "devos-brainstorming" || ref.id === "devos-writing-plans") {
      if (input.phase !== "planning" || input.role !== "main_agent")
        deny(ref.id + " is Main Agent predevelopment-only",
          "Run this before freezing the worker graph");
    }
    for (const dependency of skill.requires) {
      if (off.has(dependency)) deny(ref.id + " requires disabled skill " + dependency);
      if (!selectedIds.has(dependency))
        deny(ref.id + " requires unselected skill " + dependency,
          "Select the dependency explicitly before launch");
    }
    for (const conflict of skill.conflicts)
      if (selectedIds.has(conflict))
        deny("conflicting skills " + ref.id + " and " + conflict);
    for (const other of input.selected) {
      if (other.id === ref.id) continue;
      if (byId.get(other.id)?.conflicts.includes(ref.id))
        deny("conflicting skills " + other.id + " and " + ref.id);
    }
    try {
      await verifySkillFiles(skill, options.roots);
      if (skill.source.kind !== "upstream") {
        const content = (await readPinnedSkillResource(skill, "SKILL.md", options.roots))
          .toString("utf8");
        const directive = findConflictingSkillDirective(content);
        if (directive) deny("skill " + ref.id + " contains competing execution instructions",
          "Remove or adapt directive: " + directive);
      }
    } catch (error) {
      if (String((error as Error).message).startsWith("Skill preflight blocked:"))
        throw error;
      deny("skill " + ref.id + " failed pinned file integrity",
        "Repair or reinstall reviewed source; " + (error as Error).message);
    }
  }
  if (input.phase === "planning" && input.role !== "main_agent")
    deny("only Main Agent owns predevelopment planning");
  let stageSkill: OriginalSpecKitPin | undefined;
  if (input.specKitStage !== null) {
    const isExecutionStage = ["implement","converge"].includes(input.specKitStage);
    if (isExecutionStage !== (input.phase === "execution"))
      deny("original Spec Kit stage not valid for " + input.phase);
    try {
      stageSkill = await validateStage(input.specKitStage,
        options.stagePins, options.roots.projectRoot);
    } catch (error) {
      deny("mandatory original Spec Kit stage cannot be omitted or changed",
        (error as Error).message);
    }
  }
  // Never silently replace the exact source, assign extra skills or mutate the request.
  return { role: input.role, phase: input.phase,
    ...(input.specKitStage === null ? {} : { specKitStage: input.specKitStage }),
    ...(stageSkill ? { stageSkillId: stageSkill.skillId } : {}),
    skills: input.selected.map(ref => ({ ...ref })),
  };
}
