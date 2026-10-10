import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {ChatAccessRegistry} from "./chat-access.js";
import {OwnerTaskApprovalStore,trustedTaskApprovalVerifier} from "./owner-task-approval.js";
import {intakeDigest,type OwnerApprovalEvidence,type ApprovalKind} from "./main-agent-intake.js";
import {projectGraphDigest,type MainAgentProjectPlan} from "./main-agent-project-plan.js";
import {issueSkillsApprovalDigest,prepareApprovedRunnerSkills,
  type ApprovedWorkerChoice} from "./runner-skill-preparation.js";

const run=promisify(execFile);
const H40=/^[0-9a-f]{40}$/;
const H64=/^[0-9a-f]{64}$/;
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");

/** Dedicated local, host-side adapter for an actual password-backed receipt.
 * It does NOT expose signing or owner approval over MCP.
 * Multi-Issue Projects require a distinct receipt for each Issue. */
export async function prepareRunnerSkillsFromOwnerReceipt(args:{
  root:string;project:MainAgentProjectPlan;issue:number;
  choices:ApprovedWorkerChoice[];ownerSecret:string;approvalRef:string;
  upstreamRoot?:string;chatAccessRoot?:string;
}):Promise<{graphSha256:string;workers:string[];rosterDigest:string}>{
  const {root,project,issue,choices,ownerSecret,approvalRef}=args;
  if(project.issues.length!==1 || project.issues[0]?.issue!==issue ||
     !/^devos-owner-approval:[0-9a-f-]{36}$/.test(approvalRef))
    throw new Error("One exact task and authenticated owner approval receipt required");  const planned=project.issues[0];
  const pr=planned.linkedPr,commit=planned.intent.artifacts?.commit;
  if(!pr || !commit || !H40.test(commit) ||
    planned.workflow.task.pr!==pr || planned.workflow.task.repo!==project.repo)
    throw new Error("Original exact Issue/PR/commit contract required");
  // Never ratify the upstream template or uncommitted local edits.
  const file=".specify/memory/constitution.md";
  const {stdout:committed}=await run("git",["show",commit+":"+file],
    {cwd:root,maxBuffer:1024*1024});
  const working=await readFile(join(root,file),"utf8");
  if(committed!==working || /\[(?:PROJECT_NAME|PRINCIPLE_[1-5]_NAME|CONSTITUTION_VERSION)\]/.test(working))
    throw new Error("Committed, non-template original Constitution required");
  const constitutionSha=sha(committed);
  if(!H64.test(constitutionSha))throw new Error("Invalid Constitution SHA");
  const binding={repo:project.repo,issue,pr,gitSha:commit,constitutionSha};
  const store=new OwnerTaskApprovalStore(args.chatAccessRoot??root,ownerSecret,
    new ChatAccessRegistry(args.chatAccessRoot??root,ownerSecret));
  if(!store.verify(approvalRef,{kind:"constitution",digest:constitutionSha},binding))
    throw new Error("Original Constitution not independently ratified by owner");
  const evidence=(kind:ApprovalKind,digest:string):OwnerApprovalEvidence=>({
    kind,reviewedDigest:digest,userMessageRef:approvalRef,
  });
  const verifiedProject=structuredClone(project);
  const target=verifiedProject.issues[0];
  if(!target)throw new Error("Missing original Issue");
  const scope=intakeDigest(target.intent);
  const required:ApprovalKind[]=target.intent.size==="architectural"
    ? ["scope","spec","plan"] : ["scope"];  target.ownerEvidence=required.map(kind=>evidence(kind,scope));
  target.graphApproval=evidence("plan",projectGraphDigest(target,project.epic));
  const rosterApproval=evidence("plan",
    issueSkillsApprovalDigest(verifiedProject,issue,choices));
  const verify=trustedTaskApprovalVerifier(store,binding);
  // Signed receipt is independently verified again by every existing
  // original Main Agent / Runner preflight call. No synthetic callback.
  return prepareApprovedRunnerSkills({root,project:verifiedProject,issue,choices,
    rosterApproval,verifyOwner:verify,ownerSecret,
    ...(args.upstreamRoot?{upstreamRoot:args.upstreamRoot}:{})});
}