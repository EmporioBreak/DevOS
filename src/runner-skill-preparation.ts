import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {prepareApprovedProjectPlan,projectGraphDigest,
  type MainAgentProjectPlan} from "./main-agent-project-plan.js";
import {type OwnerApprovalEvidence,type TrustedApprovalVerifier} from "./main-agent-intake.js";
import {resolveWorkerSkills,readSkillPolicy,saveWorkerSkillManifest,
  type WorkerSkillContext} from "./skill-policy.js";
import {sealRunnerSkillGraph} from "./runner-skill-graph.js";
import {parseSkillLibrary} from "./skills-library.js";
import {validateQualityMethodPolicy} from "./quality-methods.js";
import type {SkillPreflightOptions} from "./skill-preflight.js";

export interface ApprovedWorkerChoice {
  workerId:string;
  role:"developer"|"reviewer"|"qa"|"auditor";
  phase:"execution";
  specKitStage:string|null;
  optionalCandidates:string[];
}
const hash=(x:unknown)=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
export function issueSkillsApprovalDigest(
  project:MainAgentProjectPlan,issue:number,choices:ApprovedWorkerChoice[],
):string{
  const planned=project.issues.find(x=>x.issue===issue);
  if(!planned)throw new Error("Approved Issue not included in Main Agent plan");
  // Bind to the exact owner-approved task graph and all skill/stage identities.
  return hash({version:1,issue,graph:projectGraphDigest(planned,project.epic),
    choices:choices.map(c=>({
      workerId:c.workerId,role:c.role,phase:c.phase,
      specKitStage:c.specKitStage,optionalCandidates:c.optionalCandidates,
    }))});
}
/** Main Agent creates signed worker manifests before DevOS Runner starts.
 * Caller must authenticate both the original issue plan and the exact
 * stage/skill roster against owner messages; no self-approval/default.
 */
export async function prepareApprovedRunnerSkills(args:{
  root:string;project:MainAgentProjectPlan;issue:number;
  choices:ApprovedWorkerChoice[];
  rosterApproval:OwnerApprovalEvidence;
  verifyOwner:TrustedApprovalVerifier;
  ownerSecret:string;upstreamRoot?:string;
}):Promise<{graphSha256:string;workers:string[];rosterDigest:string}>{
  const {root,project,issue,choices,verifyOwner,rosterApproval,ownerSecret}=args;
  if(!verifyOwner || !Array.isArray(choices) ||
      choices.length<1 || choices.length>32 ||
      !ownerSecret || Buffer.byteLength(ownerSecret)<32)
    throw new Error("Main Agent must provide approved immutable worker roster");
  const verified=await prepareApprovedProjectPlan(project,{
    projectRoot:root,verifyApproval:verifyOwner});
  const planned=project.issues.find(x=>x.issue===issue);
  if(!verified.issues.some(x=>x.issue===issue) || !planned ||
      planned.workflow.skillsMode!=="strict")
    throw new Error("Approved Issue must declare strict Runner skills mode");
  if(choices.length!==planned.workflow.workers.length ||
      choices.some((c,i)=>c.workerId!==planned.workflow.workers[i]?.id ||
        c.phase!=="execution" ||
        !["developer","reviewer","qa","auditor"].includes(c.role) ||
        !Array.isArray(c.optionalCandidates)))
    throw new Error("Main Agent skill roster does not match predeclared graph");
  const rosterDigest=issueSkillsApprovalDigest(project,issue,choices);
  if(rosterApproval.kind!=="plan"||!rosterApproval.userMessageRef ||
      rosterApproval.reviewedDigest!==rosterDigest ||
      !await verifyOwner(rosterApproval,{kind:"plan",digest:rosterDigest}))
    throw new Error("Skill stage/role roster lacks independent owner approval");
  const upstreamRoot=args.upstreamRoot??process.env.DEVOS_UPSTREAM_ROOT??
    join(homedir(),".devos-staging","upstream");
  const lib=parseSkillLibrary(JSON.parse(await readFile(join(root,"config","devos-skills.json"),"utf8")));
  const quality=validateQualityMethodPolicy(JSON.parse(
    await readFile(join(root,"config","devos-quality-methods.json"),"utf8")));
  const stagePins=JSON.parse(await readFile(join(root,"config","devos-speckit-stage-pins.json"),"utf8"));
  const lock=JSON.parse(await readFile(join(root,"config","devos-upstreams.lock.json"),"utf8")) as
    {version:number;sources:Array<{id:string;commit:string}>};
  if(lock.version!==1||!Array.isArray(lock.sources))
    throw new Error("Missing exact original upstream pins");
  const options:SkillPreflightOptions={library:lib,qualityPolicy:quality,
    stagePins,roots:{projectRoot:root,upstreamRoot,
      upstreamPins:Object.fromEntries(lock.sources.map(x=>[x.id,x.commit]))}};
  const policy=await readSkillPolicy(root);
  // Preflight *all* declared workers before writing the first assignment.
  const resolved=[];
  for(const choice of choices){
    const ctx:WorkerSkillContext={repo:project.repo,issue,workerId:choice.workerId,
      role:choice.role,phase:choice.phase,
      specKitStage:choice.specKitStage,
      optionalCandidates:choice.optionalCandidates};
    resolved.push(await resolveWorkerSkills(ctx,policy,options));
  }
  for(const manifest of resolved)
    await saveWorkerSkillManifest(root,manifest,ownerSecret);
  const graphSha256=await sealRunnerSkillGraph(root,planned.workflow,ownerSecret,
    async()=>verifyOwner(rosterApproval,{kind:"plan",digest:rosterDigest}),upstreamRoot);
  return {graphSha256,workers:resolved.map(x=>x.workerId),rosterDigest};
}
