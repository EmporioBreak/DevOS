import {
  parseSkillLibrary, verifySkillFiles,
  type SkillLibrary, type SkillRoots,
} from "./skills-library.js";

export type QualityPhase = "implement" | "debug" | "review-feedback" | "review" | "complete";
export type QualityRole = "developer" | "reviewer";
export interface QualityMethod {
  id: string;
  skillId: string;
  phases: QualityPhase[];
  roles: QualityRole[];
  evidence: string[];
}
export interface QualityMethodPolicy {
  version: 1;
  methods: QualityMethod[];
  neverAutoActivate: string[];
}

const APPROVED_METHODS: Record<string, string> = {
  "test-first": "superpowers-test-driven-development",
  "root-cause": "superpowers-systematic-debugging",
  "review-feedback": "superpowers-receiving-code-review",
  "verification": "superpowers-verification-before-completion",
};
const PROHIBITED = new Set([
  "superpowers-requesting-code-review",
  "superpowers-subagent-driven-development",
  "superpowers-executing-plans",
  "superpowers-dispatching-parallel-agents",
  "superpowers-using-git-worktrees",
  "superpowers-finishing-a-development-branch",
]);
const PHASES = new Set<QualityPhase>([
  "implement", "debug", "review-feedback", "review", "complete",
]);
const ROLES = new Set<QualityRole>(["developer", "reviewer"]);

export function validateQualityMethodPolicy(value: unknown): QualityMethodPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Quality methods policy must be an object");
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.methods) ||
      !Array.isArray(obj.neverAutoActivate) ||
      Object.keys(obj).some(x => !["version", "methods", "neverAutoActivate"].includes(x)))
    throw new Error("Malformed quality policy");
  if (obj.methods.length !== Object.keys(APPROVED_METHODS).length)
    throw new Error("Missing or extra quality methods");
  const methods: QualityMethod[] = [];
  for (const input of obj.methods) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Malformed quality method");
    const method = input as Record<string, unknown>;
    if (typeof method.id !== "string" ||
        method.skillId !== APPROVED_METHODS[method.id])
      throw new Error("Method uses an unapproved skill");
    if (!Array.isArray(method.phases) || !method.phases.length ||
        method.phases.some(x => !PHASES.has(x)) ||
        !Array.isArray(method.roles) || !method.roles.length ||
        method.roles.some(x => !ROLES.has(x)) ||
        !Array.isArray(method.evidence) || method.evidence.length < 2 ||
        method.evidence.some(x => typeof x !== "string" || !x.trim()) ||
        Object.keys(method).some(x => !["id", "skillId", "phases", "roles", "evidence"].includes(x)))
      throw new Error("Incomplete quality phase/role/evidence mapping");
    methods.push(method as unknown as QualityMethod);
  }
  if (new Set(methods.map(x => x.id)).size !== methods.length)
    throw new Error("Duplicate quality method mapping");
  if (obj.neverAutoActivate.length !== PROHIBITED.size ||
      new Set(obj.neverAutoActivate).size !== PROHIBITED.size ||
      !obj.neverAutoActivate.every(x => typeof x === "string" && PROHIBITED.has(x)))
    throw new Error("Unsafe skill activation policy");
  return { version: 1, methods, neverAutoActivate: obj.neverAutoActivate as string[] };
}

export async function verifyQualityMethodSources(
  policy: QualityMethodPolicy,
  library: SkillLibrary,
  roots: SkillRoots,
): Promise<void> {
  const safe = validateQualityMethodPolicy(policy);
  const catalog = parseSkillLibrary(library);
  for (const method of safe.methods) {
    const skill = catalog.skills.find(x => x.id === method.skillId);
    if (!skill || skill.source.kind !== "upstream")
      throw new Error(`Required original quality skill missing: ${method.skillId}`);
    await verifySkillFiles(skill, roots);
  }
}

/** Advisory quality methods: Main Agent / task skill selection remains authoritative. */
export function qualityMethodsFor(
  policy: QualityMethodPolicy, role: QualityRole, phase: QualityPhase,
): QualityMethod[] {
  if (!ROLES.has(role) || !PHASES.has(phase))
    throw new Error("Unknown quality role/phase");
  const safe = validateQualityMethodPolicy(policy);
  return safe.methods.filter(method =>
    method.roles.includes(role) && method.phases.includes(phase));
}

export function assertSafeQualitySelection(
  policy: QualityMethodPolicy, selectedSkillIds: string[],
): void {
  const safe = validateQualityMethodPolicy(policy);
  const forbidden = selectedSkillIds.find(id => safe.neverAutoActivate.includes(id));
  if (forbidden) throw new Error(`Skill must not self-dispatch worker/Git review: ${forbidden}`);
  if (new Set(selectedSkillIds).size !== selectedSkillIds.length)
    throw new Error("Duplicate quality skill selection");
}
