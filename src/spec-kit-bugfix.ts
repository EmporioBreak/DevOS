import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {intakeDigest,decideIntake,type IntakeContract,
  type OwnerApprovalEvidence,type TrustedApprovalVerifier} from "./main-agent-intake.js";
import {verifyScenarioStage,type OriginalScenarioStageEvidence,
  type OriginalScenarioVerifier} from "./spec-kit-scenarios.js";

export type BugfixPhase="assess"|"fix"|"test"|"review"|"owner_acceptance";
export interface BugfixCheck {
  name:string;command:string;result:"pass"|"fail"|"skipped"|"not-run";
  /** Authenticated observation of an actual check, never just model prose. */
  sourceRef:string;
}
export interface BugfixFixEvidence{
  issue:number;pr:number;workerId:string;
  reproducedBefore:boolean;rootCause:string;
  changedFiles:string[];approvedFiles:string[];
  tests:BugfixCheck[];
  verdict:"verified"|"partial"|"failed";
  reviewerRef:string;implementedRef:string;
  recordedScopeDigest:string;
}
export type VerifyBugfixEvidence=(evidence:BugfixFixEvidence,
  expected:{issue:number;pr:number;scopeDigest:string;verdict:string})=>Promise<boolean>;
export type VerifyBugfixCheck=(check:BugfixCheck,context:{
  issue:number;pr:number;scopeDigest:string;
})=>Promise<boolean>;
export interface BugfixReadiness {
  readyForOwnerAcceptance:boolean;
  status:"awaiting_assessment"|"awaiting_fix"|"awaiting_test"|"needs_rework"|"final_review_required";
  missing:string[];
  issue:number;pr:number;canonicalArtifacts:string[];
  nextOriginalStage:string|null;
  ownerApproved:false;
}
const FIELD=/^[A-Za-z0-9_.:-]{6,120}$/;
const clean=(v:string)=>typeof v==="string"&&v.trim()&&v.length<=500 &&
  !/[\r\n\0]/.test(v);
export async function assessBugfixReadiness(input:{
  root:string;intake:IntakeContract;
  ownerEvidence:OwnerApprovalEvidence[];
  verifyOwner:TrustedApprovalVerifier;
  originalStages:OriginalScenarioStageEvidence[];
  verifyStage:OriginalScenarioVerifier;
  fix?:BugfixFixEvidence;
  verifyFix?:VerifyBugfixEvidence;
  verifyCheck?:VerifyBugfixCheck;
  upstreamRoot?:string;
}):Promise<BugfixReadiness> {
  const {root,intake}=input;
  if(intake.scenario!=="bugfix"||intake.artifacts?.scenario!=="bugfix" ||
      !input.verifyOwner||!input.verifyStage||!Array.isArray(input.originalStages))
    throw new Error("Bugfix must use original approved Spec Kit Bugfix scenario");
  const contract=intake.artifacts;
  const approval=await decideIntake(intake,{projectRoot:root,
    approvals:input.ownerEvidence,verifyApproval:input.verifyOwner});
  if(approval.status!=="approved_for_issue")
    throw new Error("Owner-approved bugfix scope not independently verified");
  const issue=contract.task.issue,pr=input.fix?.pr??0;
  const paths=Object.values(contract.artifacts);
  const result=(status:BugfixReadiness["status"],missing:string[],stage:string|null):BugfixReadiness=>({
    readyForOwnerAcceptance:status==="final_review_required",
    status,issue,pr,canonicalArtifacts:paths,nextOriginalStage:stage,
    missing,ownerApproved:false,
  });
  const order=["assessment","fix","test"] as const;
  if(new Set(input.originalStages.map(x=>x.stage)).size!==input.originalStages.length||
      input.originalStages.length>order.length||
      input.originalStages.some((s,i)=>s.stage!==order[i]))
    throw new Error("Original Bugfix stages must be ordered without duplicate/skip");
  for(const [i,stage] of order.entries()){
    const evidence=input.originalStages[i];
    if(!evidence)return result(
      stage==="assessment"?"awaiting_assessment":stage==="fix"?"awaiting_fix":"awaiting_test",
      ["Missing verified original "+stage+" artifact"],"speckit.bug."+(
        stage==="assessment"?"assess":stage));
    await verifyScenarioStage(root,contract,"bug",stage,evidence,
      input.verifyStage,input.upstreamRoot);
  }
  const fix=input.fix;
  if(!fix || !input.verifyFix || !input.verifyCheck)
    return result("needs_rework",["Missing independent bugfix implementation/review proof"],"speckit.bug.test");
  if(fix.issue!==issue||!Number.isSafeInteger(fix.pr)||fix.pr<1 ||
      !FIELD.test(fix.reviewerRef)||!FIELD.test(fix.implementedRef)||
      fix.recordedScopeDigest!==intakeDigest(intake) ||
      !clean(fix.rootCause)|| !fix.reproducedBefore ||
      !Array.isArray(fix.tests)||!fix.tests.length ||
      !Array.isArray(fix.changedFiles)||!Array.isArray(fix.approvedFiles)||
      !fix.changedFiles.length||new Set(fix.changedFiles).size!==fix.changedFiles.length ||
      fix.changedFiles.some(path=>!fix.approvedFiles.includes(path))||
      !["verified","partial","failed"].includes(fix.verdict))
    throw new Error("Bugfix scope, root cause, reproduction or review evidence invalid");
  const checks=fix.tests;
  if(new Set(checks.map(x=>x.name)).size!==checks.length ||
      checks.some(x=>!clean(x.name)||!clean(x.command)||!FIELD.test(x.sourceRef) ||
        !["pass","fail","skipped","not-run"].includes(x.result)))
    throw new Error("Invalid bugfix regression/reproduction checks");
  const scope=intakeDigest(intake);
  for(const check of checks){
    if(!await input.verifyCheck(check,{issue,pr:fix.pr,scopeDigest:scope}))
      throw new Error("Bugfix check did not have verified host execution evidence");
  }
  if(!await input.verifyFix(fix,{issue,pr:fix.pr,scopeDigest:scope,verdict:fix.verdict}))
    throw new Error("Bugfix implementation or independent review not verified");
  const names=checks.map(x=>x.name.toLowerCase());
  if(!names.some(x=>x.includes("repro"))||!names.some(x=>x.includes("regression")))
    throw new Error("Bugfix must separately verify original reproducer and regression test");
  if(fix.verdict!=="verified"||checks.some(c=>c.result!=="pass"))
    return result("needs_rework",["Test verdict is partial/failed, skipped, or incomplete"],"speckit.bug.fix");
  return result("final_review_required",[],null);
}
