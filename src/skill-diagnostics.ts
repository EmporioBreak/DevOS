import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSkillLibrary, verifySkillFiles, previewSkillUpdate,
  type SkillDefinition, type SkillLibrary, type SkillRoots } from "./skills-library.js";
import { parseSkillPolicy, readSkillPolicy, resolveWorkerSkills,
  readWorkerSkillManifest, type WorkerSkillContext, type ResolvedWorkerSkills } from "./skill-policy.js";
import { validateQualityMethodPolicy } from "./quality-methods.js";
import type { SpecKitStagePins } from "./skill-preflight.js";

export interface SkillsDiagnosticOptions {
  /** Local owner-authenticated context: do not expose this value in returned data. */
  ownerSecret?: string;
  upstreamRoot?: string;
  context?: WorkerSkillContext;
}
export interface SkillsDiagnosticReport {
  version: 1;
  totals: { installed: number; unavailable: number; integrity_failed: number };
  upstream: Array<{ id:string; commit:string; license:string }>;
  skills: Array<{
    id:string; version:string; origin:string; pinnedCommit:string|null;
    sourceStatus:"installed"|"unavailable"|"integrity_failed";
    advice:string; configuredMode?:string; configuredScope?:string;
  }>;
  policy: { ruleCount:number; fingerprint:string };
  currentIssue?: {
    repo:string;issue:number;workerId:string;role:string;
    assignmentStatus:"verified"|"missing"|"unverified"|"invalid";
    frozen?: {
      sha256:string; stage:string|null;
      selected:Array<{id:string;version:string;mode:string;rule:string}>;
      skipped:Array<{id:string;reason:string}>;
    };
    effectiveStatus:"verified"|"blocked";
    assignmentMatchesCurrentPolicy?:boolean;
    effective?: {sha256:string;selected:Array<{id:string;version:string;mode:string;rule:string}>;
      skipped:Array<{id:string;reason:string}>};
    reason?:string;
  };
}

function safeReason(error:unknown):string {
  const text=error instanceof Error?error.message:String(error);
  if (/missing|ENOENT|unavailable/i.test(text)) return "Pinned resource is unavailable";
  if (/revision|version mismatch|older|downgrade/i.test(text)) return "Pinned version differs from registered revision";
  if (/signature|MAC|owner secret|signed/i.test(text)) return "Signed worker manifest could not be verified";
  if (/off|disabled|required|mandatory/i.test(text)) return "Required or disabled skill selection conflicts with policy";
  if (/conflict|duplicate|unsafe|unsupported|subagent/i.test(text)) return "Selected skills contain incompatible instructions";
  if (/SHA|digest|integrity|drift/i.test(text)) return "Pinned file integrity check failed";
  return "Skill verification failed; inspect private local diagnostics";
}
function safeSkipReason(reason:string):string {
  if (/^off at (global|project|role|task) scope$/.test(reason)) return reason;
  if (reason==="not registered in Skills Library") return reason;
  return safeReason(reason);
}
function matchingRule(policy: ReturnType<typeof parseSkillPolicy>, skillId:string,ctx:WorkerSkillContext) {
  const levels=["task","role","project","global"];
  const key=ctx.repo+"#"+ctx.issue;
  return levels.map(scope=>policy.rules.find(x=>x.skillId===skillId && x.scope===scope &&
    (scope==="global" || scope==="project" && x.context===ctx.repo ||
      scope==="role" && x.context===ctx.role ||
      scope==="task" && x.context===key))).find(Boolean);
}
async function allInputs(root:string,upstreamRoot?:string) {
  const catalog=parseSkillLibrary(JSON.parse(await readFile(join(root,"config","devos-skills.json"),"utf8")));
  const policy=await readSkillPolicy(root);
  const upstream=JSON.parse(await readFile(join(root,"config","devos-upstreams.lock.json"),"utf8")) as {
    version:number;sources:Array<{id:string;commit:string;license:string}>;
  };
  if (upstream.version!==1 || !Array.isArray(upstream.sources)) throw new Error("Invalid upstream pin lock");
  const roots:SkillRoots={projectRoot:root,
    upstreamRoot:upstreamRoot??process.env.DEVOS_UPSTREAM_ROOT??join(homedir(),".devos-staging","upstream"),
    upstreamPins:Object.fromEntries(upstream.sources.map(s=>[s.id,s.commit]))};
  return {catalog,policy,roots,upstream};
}

export async function getSkillsDiagnostics(
  root:string, options:SkillsDiagnosticOptions={},
):Promise<SkillsDiagnosticReport> {
  const {catalog,policy,roots,upstream}=await allInputs(root,options.upstreamRoot);
  const {createHash}=await import("node:crypto");
  const fingerprint=createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  const results:SkillsDiagnosticReport["skills"]=[];
  let installed=0,unavailable=0,integrity_failed=0;
  for (const skill of catalog.skills) {
    let status:typeof results[number]["sourceStatus"]="installed";
    try {await verifySkillFiles(skill,roots);}
    catch(error) {
      const code=(error as NodeJS.ErrnoException).code;
      status=code==="ENOENT"?"unavailable":"integrity_failed";
    }
    if(status==="installed") installed++;
    if(status==="unavailable") unavailable++;
    if(status==="integrity_failed") integrity_failed++;
    const configured=options.context?matchingRule(policy,skill.id,options.context):undefined;
    results.push({
      id:skill.id,version:skill.version,origin:skill.source.kind,
      pinnedCommit:skill.source.kind==="upstream"?skill.source.commit??null:null,
      sourceStatus:status,
      advice:status==="installed"?"Pinned source and resources verified"
        :status==="unavailable"?"Restore the exact approved skill source; do not execute"
        :"Skill source SHA or file set differs; stop and compare before release",
      ...(configured?{configuredMode:configured.mode,configuredScope:configured.scope}:{}),
    });
  }
  const report:SkillsDiagnosticReport={
    version:1,totals:{installed,unavailable,integrity_failed},
    upstream:upstream.sources.map(x=>({id:x.id,commit:x.commit,license:x.license})),
    skills:results,policy:{ruleCount:policy.rules.length,fingerprint},
  };
  if(options.context) {
    const ctx=options.context;
    let assignmentStatus: "verified"|"missing"|"unverified"|"invalid"="missing";
    let frozen:NonNullable<SkillsDiagnosticReport["currentIssue"]>["frozen"];
    if(options.ownerSecret) {
      try {
        const previous=await readWorkerSkillManifest(root,{repo:ctx.repo,issue:ctx.issue},
          ctx.workerId,options.ownerSecret);
        if (previous.role!==ctx.role || previous.phase!==ctx.phase ||
            previous.specKitStage!==ctx.specKitStage)
          throw new Error("Signed assignment role or stage does not match inspected worker");
        assignmentStatus="verified";
        frozen={
          sha256:previous.sha256,stage:previous.specKitStage,
          selected:previous.selected.map(x=>({id:x.id,version:x.version,mode:x.mode,rule:x.rule})),
          skipped:previous.skipped.map(x=>({id:x.skillId,reason:safeSkipReason(x.reason)})),
        };
      } catch(error) {
        assignmentStatus=(error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"invalid";
      }
    } else assignmentStatus="unverified";
    let effectiveStatus:"verified"|"blocked"="verified";
    let effective:NonNullable<SkillsDiagnosticReport["currentIssue"]>["effective"];
    let reason:string|undefined;
    try {
      const qualityPolicy=validateQualityMethodPolicy(JSON.parse(
        await readFile(join(root,"config","devos-quality-methods.json"),"utf8")));
      const stagePins=JSON.parse(await readFile(join(root,"config","devos-speckit-stage-pins.json"),"utf8")) as SpecKitStagePins;
      const checked=await resolveWorkerSkills(ctx,policy,{library:catalog,qualityPolicy,stagePins,roots});
      effective={sha256:checked.sha256,
        selected:checked.selected.map(x=>({id:x.id,version:x.version,mode:x.mode,rule:x.rule})),
        skipped:checked.skipped.map(x=>({id:x.skillId,reason:safeSkipReason(x.reason)}))};
    } catch(error) {
      effectiveStatus="blocked";
      reason=safeReason(error);
    }
    report.currentIssue={repo:ctx.repo,issue:ctx.issue,workerId:ctx.workerId,
      role:ctx.role,assignmentStatus,effectiveStatus,
      ...(frozen&&effective?{assignmentMatchesCurrentPolicy:
        JSON.stringify(frozen.selected)===JSON.stringify(effective.selected)}:{}),
      ...(frozen?{frozen}:{}),...(effective?{effective}:{}),...(reason?{reason}:{})};
  }
  return report;
}

export async function previewSkillsUpdate(
  root:string, skillId:string, candidate:SkillDefinition,
):Promise<{
  skillId:string;oldVersion:string;newVersion:string;reviewFingerprint:string;
  added:string[];removed:string[];changed:string[];
  upstreamRevisionChanged:boolean;adaptationsToReview:string[];
  releaseReady:false;releaseBlocks:string[];
}> {
  const {catalog}=await allInputs(root);
  const old=catalog.skills.find(s=>s.id===skillId);
  if (!old) throw new Error("Skill is not registered in pinned Skills Library");
  const diff=previewSkillUpdate(old,candidate);
  const revisions=old.source.kind==="upstream" && candidate.source.kind==="upstream" &&
    (old.source.commit!==candidate.source.commit ||
     old.source.upstreamId!==candidate.source.upstreamId);
  const adapted=catalog.skills.filter(s=>s.source.kind==="adapted" &&
    s.source.derivedFrom===old.id+"@"+old.version).map(s=>s.id).sort();
  const releaseBlocks=[
    "Review exact upstream/vendor diff, source commit and license",
    "Re-pin and verify all SKILL.md/reference/script/asset bytes before use",
    "Obtain Main Agent approval and review the GitHub PR",
    "Run focused and staging integration tests before promotion",
    ...(adapted.length?["Re-review adapted skills: "+adapted.join(", ")]:[]),
  ];
  return {skillId:old.id,oldVersion:diff.oldVersion,newVersion:diff.newVersion,
    reviewFingerprint:diff.reviewFingerprint,added:diff.added,removed:diff.removed,
    changed:diff.changed,upstreamRevisionChanged:revisions,
    adaptationsToReview:adapted,releaseReady:false,releaseBlocks};
}
