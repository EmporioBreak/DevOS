import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, lstat, realpath, open, rm, link, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseSkillLibrary, type SkillLibrary } from "./skills-library.js";
import { preflightSkills, type SkillPreflightOptions,
  type SkillPreflightRequest, type SkillSelection } from "./skill-preflight.js";

export type SkillMode = "required" | "optional" | "off";
export type SkillPolicyScope = "global" | "project" | "role" | "task";
export interface SkillPolicyRule {
  scope: SkillPolicyScope;
  /** global: absent; project: owner/repo; role: stable role; task: owner/repo#issue */
  context?: string;
  skillId: string;
  mode: SkillMode;
}
export interface DevosSkillPolicy {
  version: 1;
  rules: SkillPolicyRule[];
}
export interface WorkerSkillContext {
  repo: string;
  issue: number;
  workerId: string;
  role: string;
  phase: "planning" | "execution";
  specKitStage: string | null;
  optionalCandidates: string[];
}
export interface ResolvedWorkerSkills {
  version: 1;
  task: { repo: string; issue: number };
  workerId: string;
  role: string;
  phase: "planning" | "execution";
  specKitStage: string | null;
  selected: Array<SkillSelection & { mode: "required" | "optional"; rule: string }>;
  skipped: Array<{ skillId: string; reason: string }>;
  sha256: string;
}
const IDs = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ROLE = /^[a-z][a-z0-9_]*$/;
const SCOPES: SkillPolicyScope[] = ["global","project","role","task"];
const MODES: SkillMode[] = ["required","optional","off"];

function validateRole(role: string) {
  if (!ROLE.test(role) || !["main_agent","developer","reviewer","qa","auditor"].includes(role))
    throw new Error("Invalid DevOS worker role");
}
export function parseSkillPolicy(value: unknown): DevosSkillPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Skills policy");
  const data = value as Record<string,unknown>;
  if (data.version !== 1 || !Array.isArray(data.rules) ||
      Object.keys(data).some(x => !["version","rules"].includes(x)))
    throw new Error("Unsupported Skills policy version or fields");
  const unique = new Set<string>();
  const rules: SkillPolicyRule[] = [];
  for (const entry of data.rules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid skill preference rule");
    const v = entry as Record<string,unknown>;
    if (typeof v.scope !== "string" || !SCOPES.includes(v.scope as SkillPolicyScope) ||
        typeof v.mode !== "string" || !MODES.includes(v.mode as SkillMode) ||
        typeof v.skillId !== "string" || !IDs.test(v.skillId) ||
        Object.keys(v).some(x => !["scope","context","skillId","mode"].includes(x)))
      throw new Error("Malformed skill preference");
    const scope = v.scope as SkillPolicyScope;
    if (scope === "global") {
      if (v.context !== undefined) throw new Error("Global rule must not have context");
    } else {
      if (typeof v.context !== "string" ||
          (scope === "project" && !REPO.test(v.context)) ||
          (scope === "role" && !ROLE.test(v.context)) ||
          (scope === "task" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(v.context)))
        throw new Error("Invalid skill preference context for " + scope);
    }
    const fingerprint = [scope,v.context??"",v.skillId].join("|");
    if (unique.has(fingerprint)) throw new Error("Duplicate skill preference for " + fingerprint);
    unique.add(fingerprint);
    rules.push({scope, ...(v.context === undefined ? {} : {context: v.context as string}),
      skillId:v.skillId,mode:v.mode as SkillMode});
  }
  return {version:1,rules};
}
export function updateSkillPreference(
  current: DevosSkillPolicy, preference: SkillPolicyRule, library: SkillLibrary,
): DevosSkillPolicy {
  const catalog = parseSkillLibrary(library);
  const proposal = parseSkillPolicy({version:1,rules:[preference]}).rules[0]!;
  if (!catalog.skills.some(x => x.id === proposal.skillId))
    throw new Error("Unknown registered skill " + proposal.skillId);
  const prev = parseSkillPolicy(current);
  const rules = prev.rules.filter(x =>
    !(x.scope === proposal.scope && x.context === proposal.context && x.skillId === proposal.skillId));
  rules.push(proposal);
  return parseSkillPolicy({version:1,rules});
}
export function policyFingerprint(policy: DevosSkillPolicy): string {
  const parsed = parseSkillPolicy(policy);
  return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
}
export async function readSkillPolicy(root: string): Promise<DevosSkillPolicy> {
  return parseSkillPolicy(JSON.parse(await readFile(join(root,"config","devos-skill-policy.json"),"utf8")));
}
/** Atomic compare-and-swap; modifying Git-backed settings requires a reviewed expected state. */
export async function writeSkillPolicy(
  root: string, next: DevosSkillPolicy, expectedFingerprint: string,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(expectedFingerprint)) throw new Error("Invalid expected policy revision");
  const file = join(await realpath(root),"config","devos-skill-policy.json");
  const actual = await realpath(file);
  if (actual !== file || !(await lstat(file)).isFile())
    throw new Error("Skill policy path is not a regular project file");
  const lock = file + ".update.lock";
  let handle;
  try {
    handle = await open(lock,"wx",0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Skill policy update is already in progress; retry after refresh");
    throw error;
  }
  try {
    const current = await readSkillPolicy(root);
    if (policyFingerprint(current) !== expectedFingerprint)
      throw new Error("Skill policy changed since it was read; refresh preferences");
    const verified = parseSkillPolicy(next);
    const temporary = file + ".tmp-" + randomUUID();
    try {
      await writeFile(temporary,JSON.stringify(verified,null,2)+"\n",{flag:"wx",mode:0o600});
      if (policyFingerprint(await readSkillPolicy(root)) !== expectedFingerprint)
        throw new Error("Skill policy changed during update");
      await rename(temporary,file);
    } finally {
      await rm(temporary,{force:true});
    }
    return policyFingerprint(verified);
  } finally {
    await handle.close();
    await rm(lock,{force:true});
  }
}
function matchingRule(
  policy: DevosSkillPolicy, skillId: string, ctx: WorkerSkillContext,
): SkillPolicyRule | undefined {
  const matches = policy.rules.filter(x =>
    x.skillId === skillId &&
    (x.scope === "global" ||
     (x.scope === "project" && x.context === ctx.repo) ||
     (x.scope === "role" && x.context === ctx.role) ||
     (x.scope === "task" && x.context === ctx.repo + "#" + ctx.issue)));
  return matches.sort((a,b)=>SCOPES.indexOf(b.scope)-SCOPES.indexOf(a.scope))[0];
}
/**
 * Resolve once in Main Agent before launching the predeclared worker graph.
 * Optional failures are explicitly documented; required failures stop startup.
 */
export async function resolveWorkerSkills(
  ctx: WorkerSkillContext, preferences: DevosSkillPolicy,
  options: SkillPreflightOptions,
): Promise<ResolvedWorkerSkills> {
  if (!REPO.test(ctx.repo) || !Number.isSafeInteger(ctx.issue) || ctx.issue<=0 ||
      !ctx.workerId || !/^[a-zA-Z0-9_-]{1,100}$/.test(ctx.workerId) ||
      !["planning","execution"].includes(ctx.phase) ||
      !Array.isArray(ctx.optionalCandidates) ||
      ctx.optionalCandidates.some(x=>typeof x!=="string" || !IDs.test(x)) ||
      new Set(ctx.optionalCandidates).size !== ctx.optionalCandidates.length)
    throw new Error("Invalid worker skill selection context");
  validateRole(ctx.role);
  const policy = parseSkillPolicy(preferences);
  const lib = parseSkillLibrary(options.library);
  for (const rule of policy.rules)
    if (!lib.skills.some(x=>x.id===rule.skillId))
      throw new Error("Skill policy references unknown registry skill: " + rule.skillId);
  const selected: ResolvedWorkerSkills["selected"] = [], skipped:ResolvedWorkerSkills["skipped"] = [];
  const off = lib.skills.filter(x=>matchingRule(policy,x.id,ctx)?.mode==="off").map(x=>x.id);
  const required = lib.skills.filter(x=>matchingRule(policy,x.id,ctx)?.mode==="required").map(x=>x.id);
  const base = (entries: typeof selected): SkillPreflightRequest => ({
    phase:ctx.phase,role:ctx.role,specKitStage:ctx.specKitStage,
    required,off,selected:entries.map(x=>({id:x.id,version:x.version})),
  });
  for (const skillId of required) {
    const skill = lib.skills.find(x=>x.id===skillId)!;
    const rule = matchingRule(policy,skillId,ctx)!;
    selected.push({id:skill.id,version:skill.version,mode:"required",
      rule:rule.scope+(rule.context?":"+rule.context:"")});
  }
  // Missing/unsafe required skills are never silently dropped.
  await preflightSkills(base(selected),options);
  for (const id of ctx.optionalCandidates) {
    if (required.includes(id)) continue;
    const rule = matchingRule(policy,id,ctx);
    if (rule?.mode==="off") {
      skipped.push({skillId:id,reason:"off at "+rule.scope+" scope"});
      continue;
    }
    const skill = lib.skills.find(x=>x.id===id);
    if (!skill) {
      skipped.push({skillId:id,reason:"not registered in Skills Library"});
      continue;
    }
    const candidate = {id:skill.id,version:skill.version,mode:"optional" as const,
      rule:rule ? rule.scope+(rule.context?":"+rule.context:"") : "default optional"};
    try {
      await preflightSkills(base([...selected,candidate]),options);
      selected.push(candidate);
    } catch (error) {
      skipped.push({skillId:id,reason:(error as Error).message});
    }
  }
  const payload = {
    version:1 as const,task:{repo:ctx.repo,issue:ctx.issue},
    workerId:ctx.workerId,role:ctx.role,phase:ctx.phase,
    specKitStage:ctx.specKitStage,selected,skipped,
  };
  return {...payload,sha256:createHash("sha256").update(JSON.stringify(payload)).digest("hex")};
}

/** Freeze a verified role-specific manifest before DevOS Runner starts.
 * Existing assignments are idempotent for the same exact bytes; a different
 * selection for the same Issue/worker is not authorized during continuation.
 */
export async function saveWorkerSkillManifest(
  root: string, manifest: ResolvedWorkerSkills,
): Promise<string> {
  if (manifest.version !== 1 || !REPO.test(manifest.task.repo) ||
      !Number.isSafeInteger(manifest.task.issue) || manifest.task.issue < 1 ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(manifest.workerId))
    throw new Error("Invalid worker skill assignment");
  const {sha256, ...payload} = manifest;
  if (sha256 !== createHash("sha256").update(JSON.stringify(payload)).digest("hex"))
    throw new Error("Skill assignment content hash mismatch");
  const base = join(await realpath(root), ".devos", "skills", "assignments",
    encodeURIComponent(manifest.task.repo), String(manifest.task.issue));
  await mkdir(base,{recursive:true,mode:0o700});
  if ((await realpath(base)) !== base)
    throw new Error("Worker assignment storage cannot use symlinked paths");
  const target = join(base,manifest.workerId+".json");
  const bytes = JSON.stringify(manifest,null,2)+"\n";
  const temp = target+"."+randomUUID()+".tmp";
  try {
    await writeFile(temp,bytes,{flag:"wx",mode:0o600});
    try { await link(temp,target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(target,"utf8");
      if (existing !== bytes)
        throw new Error("Worker skills already frozen for this Issue; no reassignment during execution");
    }
  } finally { await rm(temp,{force:true}); }
  return target;
}
export async function readWorkerSkillManifest(
  root: string, task: {repo:string;issue:number}, workerId:string,
): Promise<ResolvedWorkerSkills> {
  if (!REPO.test(task.repo) || !Number.isSafeInteger(task.issue) || task.issue<1 ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(workerId))
    throw new Error("Invalid worker skill assignment reference");
  const path = join(await realpath(root),".devos","skills","assignments",
    encodeURIComponent(task.repo),String(task.issue),workerId+".json");
  const manifest = JSON.parse(await readFile(path,"utf8")) as ResolvedWorkerSkills;
  if (manifest.task.repo!==task.repo || manifest.task.issue!==task.issue ||
      manifest.workerId!==workerId || manifest.version!==1)
    throw new Error("Worker skill assignment identity mismatch");
  const {sha256, ...payload}=manifest;
  if (sha256!==createHash("sha256").update(JSON.stringify(payload)).digest("hex"))
    throw new Error("Worker skill assignment integrity mismatch");
  return manifest;
}
