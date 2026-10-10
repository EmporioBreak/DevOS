import { createHash } from "node:crypto";
import { decideIntake, intakeDigest,
  type IntakeContract, type OwnerApprovalEvidence, type TrustedApprovalVerifier,
} from "./main-agent-intake.js";
import { embedSpecKitContract, validateSpecKitDependencyGraph,
  type SpecKitArtifactContract } from "./spec-kit-contract.js";
import { parseWorkflow } from "./workflow-loader.js";
import type { Workflow } from "./workflow.js";

/** Concrete action needs, selected by Main Agent from actual acceptance.
 * These are evidence modalities, NOT task-category-to-executor routing rules.
 * The signed owner-approved plan freezes the exact worker/action assignment.
 */
export type WorkerActionCapability =
  "host_command" | "scripted_ui_test" | "visual_desktop_test" | "ios_simulator_visual_test";
export interface WorkerActionRequirement {
  id:string;
  acceptanceIndex:number;
  workerId:string;
  capability:WorkerActionCapability;
}
export interface VerifiedWorkerActionEvidence {
  task:{repo:string;issue:number};
  workerId:string;
  actionId:string;
  executor:"codex"|"chatgpt_browser";
  /** Obtained by an independent trusted host/tool capability probe,
   * never from worker text, screenshot filenames or role labels. */
  observed:readonly string[];
  sessionBound:boolean;
}
export type TrustedWorkerActionVerifier = (requirement:{
  task:{repo:string;issue:number};workerId:string;executor:"codex"|"chatgpt_browser";
  actionId:string;capability:WorkerActionCapability;acceptance:string;
})=>Promise<VerifiedWorkerActionEvidence|null>;

const CAPABILITY_EVIDENCE:Record<WorkerActionCapability,readonly string[]>={
  host_command:["shell_command"],
  scripted_ui_test:["shell_command"],
  visual_desktop_test:["visual_screen","visual_pointer"],
  ios_simulator_visual_test:["ios_screen","ios_tap"],
};
const ACTION_ID=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function checkedWorkerActions(plan:ProjectIssuePlan):WorkerActionRequirement[] {
  if(plan.workerActions===undefined)return [];
  if(!Array.isArray(plan.workerActions)||plan.workerActions.length===0||plan.workerActions.length>60)
    throw new Error("Invalid Main Agent worker capability action list");
  const graph=parseWorkflow(plan.workflow);
  const workers=new Set(graph.workers.map(w=>w.id)),seen=new Set<string>();
  return plan.workerActions.map(action=>{
    if(!action || !ACTION_ID.test(action.id) || action.id.length>120 ||
       seen.has(action.id) || !workers.has(action.workerId) ||
       !Number.isSafeInteger(action.acceptanceIndex) ||
       action.acceptanceIndex<0 || action.acceptanceIndex>=plan.intent.acceptance.length ||
       !Object.hasOwn(CAPABILITY_EVIDENCE,action.capability))
      throw new Error("Invalid or duplicated Main Agent worker capability assignment");
    seen.add(action.id);
    return action;
  });
}
export interface ProjectIssuePlan {
  key:string;
  issue:number;
  title:string;
  intent:IntakeContract;
  ownerEvidence:OwnerApprovalEvidence[];
  /** Verified once before execution; exact worker graph, dependencies and PR. */
  graphApproval:OwnerApprovalEvidence;
  dependsOn:string[];
  /** GitHub's existing linked PR (if confirmed), not a new PR opened by Runner. */
  linkedPr?:number;
  workerReports?:string[];
  workerActions?:WorkerActionRequirement[];
  workflow:Workflow;
}
export interface MainAgentProjectPlan {
  version:1;
  repo:string;
  epic?:number;
  issues:ProjectIssuePlan[];
}
export interface VerifiedProjectIssue {
  issue:number;key:string;title:string;
  artifactCommit:string;approvalDigest:string;
  dependsOn:number[];body:string;
  workerGraphDigest:string;
}
export interface VerifiedProjectPlan {
  version:1;
  repo:string;epic?:number;
  issues:VerifiedProjectIssue[];
  ordering:number[];
  fingerprint:string;
}
export interface GithubIssueSnapshot {
  number:number;title:string;body:string;
  state:"open"|"closed";
}
export interface MainAgentIssuePublisher {
  /** Connector/client must authenticate permissions and fetch actual GitHub Issue. */
  readIssue(repo:string,issue:number):Promise<GithubIssueSnapshot>;
  /** No GitHub Issues or PRs are ever silently created by this updater. */
  updateIssue(repo:string,issue:number,body:string,expectedBodySha256:string):Promise<void>;
  verifyLinkedPr(repo:string,issue:number,pr:number):Promise<boolean>;
}
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KEY=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const H=/^[0-9a-f]{64}$/;
const MARKER="<!-- DEVOS_MAIN_AGENT_PLAN_V1 -->";
const END="<!-- /DEVOS_MAIN_AGENT_PLAN_V1 -->";

function digest(x:unknown):string {
  return createHash("sha256").update(JSON.stringify(x)).digest("hex");
}
/** Owner-reviewed exact graph digest, including existing dependencies and scope. */
export function projectGraphDigest(plan:ProjectIssuePlan, epic?:number):string {
  return digest({graph:taskGraph(plan.workflow),dependsOn:plan.dependsOn.map(x=>x),
    linkedPr:plan.linkedPr??null,parentEpic:epic??null,
    ownerScope:intakeDigest(plan.intent),
    ...(plan.workerActions!==undefined?{workerActions:checkedWorkerActions(plan)}:{})});
}
function text(x:unknown,label:string):string {
  if (typeof x!=="string"||!x.trim()||x.length>2000 ||
      /[\x00-\x08\x0e-\x1f]/.test(x))
    throw new Error("Invalid Main Agent "+label);
  return x.trim();
}
function unique(items:string[],label:string) {
  if(new Set(items).size!==items.length)throw new Error("Duplicate Main Agent "+label);
}
function list(items:string[]):string {
  return items.map(x=>"- "+x.replace(/\r?\n/g," ")).join("\n");
}
function taskGraph(workflow:Workflow):Workflow {
  const parsed=parseWorkflow(workflow);
  if(!parsed.owner || parsed.owner.mode!=="main_agent")
    throw new Error("Main Agent must own final acceptance of each Issue");
  // Main Agent, not Runner, chooses each executor according to its exact
  // capabilities in the *approved* immutable graph. A planned Codex stage
  // may start first or follow an ordinary `done` edge; an exceptional
  // `needs_local_worker` fallback remains separately subject to host proof.
  const workers=new Map(parsed.workers.map(worker=>[worker.id,worker]));
  const reachable=new Set<string>([parsed.start]);
  const queue=[parsed.start];
  while(queue.length){
    const id=queue.shift()!;
    for(const next of Object.values(workers.get(id)!.on)){
      if(next&&!reachable.has(next)){
        reachable.add(next);
        queue.push(next);
      }
    }
  }
  for(const worker of parsed.workers){
    if(!reachable.has(worker.id))
      throw new Error(`Main Agent graph has unreachable worker: ${worker.id}`);
  }
  const devs=parsed.workers.filter(x=>/develop|implement/i.test(x.id));
  const reviews=parsed.workers.filter(x=>/review|qa/i.test(x.id));
  if(devs.length && !reviews.length)
    throw new Error("Implementation graph must predeclare an independent reviewer");
  return parsed;
}
function topological(plans:ProjectIssuePlan[]):ProjectIssuePlan[] {
  const byKey=new Map(plans.map(x=>[x.key,x]));
  const done=new Set<string>(),active=new Set<string>();
  const result:ProjectIssuePlan[]=[];
  function visit(key:string) {
    if(active.has(key))throw new Error("Cyclic Main Agent Issue dependency");
    if(done.has(key))return;
    const issue=byKey.get(key);
    if(!issue)throw new Error("Unknown project Issue dependency: "+key);
    active.add(key);
    for(const dep of issue.dependsOn)visit(dep);
    active.delete(key);done.add(key);result.push(issue);
  }
  for(const plan of plans)visit(plan.key);
  return result;
}
export async function prepareApprovedProjectPlan(
  value:MainAgentProjectPlan,
  options:{ projectRoot:string;verifyApproval:TrustedApprovalVerifier;
    verifyWorkerAction?:TrustedWorkerActionVerifier },
):Promise<VerifiedProjectPlan> {
  if(!value || value.version!==1 || !REPO.test(value.repo) ||
      (value.epic!==undefined &&
        (!Number.isSafeInteger(value.epic)||value.epic<1)) ||
      !Array.isArray(value.issues)||value.issues.length<1||value.issues.length>75 ||
      !options.projectRoot || !options.verifyApproval)
    throw new Error("Invalid or unverified Main Agent project planning request");
  const plans=value.issues;
  unique(plans.map(x=>x.key),"Issue key");
  unique(plans.map(x=>String(x.issue)),"Issue number");
  for(const plan of plans) {
    if(!KEY.test(plan.key) || !Number.isSafeInteger(plan.issue)||plan.issue<1 ||
        !Array.isArray(plan.dependsOn) || plan.dependsOn.some(x=>!KEY.test(x)) ||
        !Array.isArray(plan.ownerEvidence) || plan.ownerEvidence.length>5 ||
        !plan.graphApproval || plan.graphApproval.kind!=="plan" ||
        (plan.linkedPr!==undefined &&
          (!Number.isSafeInteger(plan.linkedPr)||plan.linkedPr<1)))
      throw new Error("Malformed planned Issue identity or dependency");
    unique(plan.dependsOn,"Issue dependency");
    if(plan.workerReports!==undefined &&
        (!Array.isArray(plan.workerReports) || plan.workerReports.length>30 ||
         plan.workerReports.some(url=>typeof url!=="string" ||
           !url.startsWith("https://github.com/"+value.repo+"/") ||
           !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*(?:#(?:issuecomment|discussion_r|pullrequestreview)-[0-9]+)?$/.test(url))))
      throw new Error("Worker reports must be verified same-repository GitHub URLs with no secrets");
    text(plan.title,"Issue title");
    if(plan.intent.scenario==="assessment")
      throw new Error("Read-only assessment cannot become an implementation Issue automatically");
    if(plan.intent.artifacts?.task.repo!==value.repo ||
        plan.intent.artifacts.task.issue!==plan.issue)
      throw new Error("Issue and canonical artifact identity disagree");
    const graph=taskGraph(plan.workflow);
    const dependencyNumbers=plan.dependsOn.map(key=>plans.find(x=>x.key===key)?.issue);
    if(dependencyNumbers.some(x=>!x))
      throw new Error("Unresolved GitHub Issue dependency");
    if(JSON.stringify(dependencyNumbers)!==JSON.stringify(plan.intent.artifacts!.dependsOn))
      throw new Error("Changes in Issue dependencies require reapproved original Spec Kit contract");
    if(plan.intent.artifacts!.epic!==value.epic)
      throw new Error("Epic scope differs from the owner-reviewed artifact contract");
    if(graph.task.repo!==value.repo||graph.task.issue!==plan.issue ||
        graph.task.pr!==plan.linkedPr)
      throw new Error("Predeclared worker graph/linked PR differs from Issue identity");
  }
  const ordered=topological(plans);
  const contracts:SpecKitArtifactContract[]=plans.map(plan=>({
    ...plan.intent.artifacts!,
    dependsOn:plan.dependsOn.map(key=>plans.find(x=>x.key===key)!.issue),
    ...(value.epic?{epic:value.epic}:{}),
  }));
  validateSpecKitDependencyGraph(contracts);
  // Reject identical Issue descriptions or duplicated canonical artifact directories.
  unique(plans.map(x=>x.title.trim().toLowerCase()),"Issue title");
  unique(plans.map(x=>x.intent.artifacts!.artifactDirectory),"artifact directory");
  const verified:VerifiedProjectIssue[]=[];
  for(const plan of ordered) {
    const decision=await decideIntake(plan.intent,{
      projectRoot:options.projectRoot,approvals:plan.ownerEvidence,
      verifyApproval:options.verifyApproval});
    if(decision.status!=="approved_for_issue")
      throw new Error("Issue #"+plan.issue+" is not owner-approved: "+
        decision.missing.join("; "));
    const dependsOn=plan.dependsOn.map(key=>plans.find(x=>x.key===key)!.issue);
    const contract={...plan.intent.artifacts!,dependsOn,
      ...(value.epic?{epic:value.epic}:{})};
    const graph=taskGraph(plan.workflow);
    const graphHash=projectGraphDigest(plan,value.epic);
    const approved=plan.graphApproval;
    if(approved.reviewedDigest!==graphHash || !approved.userMessageRef ||
        !await options.verifyApproval(approved,{kind:"plan",digest:graphHash}))
      throw new Error("Predeclared full worker graph and Issue dependencies lack trusted owner approval");
    const workerActions=checkedWorkerActions(plan);
    const actionEvidence:string[]=[];
    if(workerActions.length&&!options.verifyWorkerAction)
      throw new Error("Missing independent host worker capability verifier");
    for(const action of workerActions){
      const worker=graph.workers.find(w=>w.id===action.workerId)!;
      const accepted=await options.verifyWorkerAction!({
        task:{repo:value.repo,issue:plan.issue},workerId:worker.id,
        executor:worker.executor,actionId:action.id,capability:action.capability,
        acceptance:plan.intent.acceptance[action.acceptanceIndex]!,
      });
      const expected=CAPABILITY_EVIDENCE[action.capability];
      if(!accepted||accepted.sessionBound!==true||
         accepted.task.repo!==value.repo||accepted.task.issue!==plan.issue||
         accepted.actionId!==action.id||accepted.workerId!==worker.id||
         accepted.executor!==worker.executor||!Array.isArray(accepted.observed)||
         accepted.observed.some((x:string)=>typeof x!=="string")||
         !expected.every(x=>accepted.observed.includes(x))){
        throw new Error("Required worker capability not independently proven: "+
          action.id+" ("+action.capability+")");
      }
      actionEvidence.push("- "+action.id+" → "+worker.id+" ("+worker.executor+") / "+
        action.capability+"; trusted host evidence: "+expected.join(" + "));
    }
    const metadata={
      version:1,repo:value.repo,issue:plan.issue,approvalDigest:intakeDigest(plan.intent),
      workerGraphDigest:graphHash,taskKey:plan.key,
      linkedPr:plan.linkedPr??null,
    };
    const body=[
      "## Owner-approved DevOS Issue — "+plan.title,
      "**User goal:** "+plan.intent.userGoal,
      "### Scope",list(plan.intent.scope),
      "### Non-goals",list(plan.intent.nonGoals),
      "### Acceptance criteria",list(plan.intent.acceptance),
      "### Scenarios",list(plan.intent.userScenarios),
      ...(actionEvidence.length?["### Independently verified worker action capabilities",
        actionEvidence.join("\n")]:[]),
      "### Depends on",dependsOn.length?dependsOn.map(x=>"- #"+x).join("\n"):"None",
      "### Implementation references",
      "- Exact original Spec Kit commit: `"+contract.commit+"`",
      "- Canonical artifacts: "+Object.values(contract.artifacts).map(x=>"`"+x+"`").join(", "),
      "- Frozen declared worker graph SHA-256: `"+graphHash+"`",
      ...(plan.linkedPr?["- Linked GitHub PR: #"+plan.linkedPr]:[]),
      ...(plan.workerReports?.length?[
        "### Worker verification reports",list(plan.workerReports),
      ]:[]),
      MARKER,"```json",JSON.stringify(metadata,null,2),"```",END,
    ].join("\n\n");
    const fullBody=embedSpecKitContract(body,contract);
    verified.push({issue:plan.issue,key:plan.key,title:plan.title,
      artifactCommit:contract.commit,approvalDigest:decision.approvalDigest,
      dependsOn,body:fullBody,workerGraphDigest:graphHash});
  }
  return {version:1,repo:value.repo,
    ...(value.epic?{epic:value.epic}:{}),
    issues:verified,ordering:ordered.map(x=>x.issue),
    fingerprint:digest(verified.map(x=>[x.issue,x.approvalDigest,
      x.artifactCommit,x.workerGraphDigest,x.dependsOn]))};
}
/** GitHub publisher is strictly Main Agent-owned.
 * Never change unrelated human-authored text or overwrite changed Issue bodies.
 * Call with a fresh expected-body hash from the actual GitHub provider.
 */
export async function publishApprovedIssue(
  proposed:MainAgentProjectPlan,number:number,
  expectedBodySha256:string,provider:MainAgentIssuePublisher,
  options:{projectRoot:string;verifyApproval:TrustedApprovalVerifier},
):Promise<"published"|"already_published"> {
  if(!H.test(expectedBodySha256))throw new Error("Expected GitHub Issue body revision required");
  // Never trust a precomputed "VerifiedProjectPlan" object from model input.
  const plan=await prepareApprovedProjectPlan(proposed,options);
  const item=plan.issues.find(x=>x.issue===number);
  if(!item)throw new Error("Issue not included in approved Main Agent project plan");
  const linkedPr=proposed.issues.find(x=>x.issue===number)?.linkedPr;
  if(linkedPr && !await provider.verifyLinkedPr(plan.repo,number,linkedPr))
    throw new Error("Linked PR not independently confirmed by GitHub");
  const actual=await provider.readIssue(plan.repo,number);
  if(actual.number!==number || actual.state!=="open")
    throw new Error("GitHub Issue does not match approved open reservation");
  if(actual.body===item.body || actual.body.includes(item.body))
    return "already_published";
  if(digest(actual.body)!==expectedBodySha256)
    throw new Error("GitHub Issue was changed concurrently; refresh before publishing");
  if(actual.body.includes(MARKER)||actual.body.includes("<!-- DEVOS_SPECKIT_V1 -->"))
    throw new Error("Existing approved contract must be revised through owner decision, not overwritten");
  await provider.updateIssue(plan.repo,number,
    (actual.body.trimEnd()?actual.body.trimEnd()+"\n\n":"")+item.body,
    expectedBodySha256);
  return "published";
}
