import {decideIntake,type IntakeContract} from "./main-agent-intake.js";
import {verifyScenarioStage,type OriginalScenarioStageEvidence,
  type OriginalScenarioVerifier} from "./spec-kit-scenarios.js";

export type AssessmentRating="strong"|"adequate"|"weak"|"unknown";
export type AssessmentVerdict="go"|"needs-clarification"|"kill";
export interface AssessmentEvidence{
  title:string;
  source:string;
  confidence:"high"|"medium"|"low"|"assumption";
  supports:boolean;
}
export interface AssessmentScore{
  criterion:"problem-validity"|"evidence-strength"|"value-vs-inaction"|
    "feasibility"|"strategic-fit"|"risk-posture";
  rating:AssessmentRating;
  rationale:string;
  evidenceRefs:string[];
}
export interface AssessmentDecision{
  verdict:AssessmentVerdict;
  rationale:string;
  scorecard:AssessmentScore[];
  evidence:AssessmentEvidence[];
  recommendedOption?:string;
  openQuestions:string[];
  /** Only indicates possible handoff; implementation requires NEW owner approval. */
  potentialFeatureScope?:string[];
  sourceRef:string;
}
export interface AssessmentResult {
  kind:"read_only_assessment";
  status:"needs_artifacts"|"ready_for_decision"|"go_candidate"|"clarify"|"kill";
  verdict:AssessmentVerdict|null;
  nextOriginalCommand:string|null;
  completedStages:string[];
  blockers:string[];
  requiresNewFeatureApproval:boolean;
  mayCreateIssue:false;
  mayCreatePr:false;
  mayRunRunner:false;
  recommendation?:string;
}
export type VerifyAssessmentDecision=(proof:AssessmentDecision,expected:{
  issue:number;verdict:AssessmentVerdict;artifactCommit:string;
})=>Promise<boolean>;
const criteria:AssessmentScore["criterion"][]=[
  "problem-validity","evidence-strength","value-vs-inaction",
  "feasibility","strategic-fit","risk-posture"];
const strength=(v:AssessmentRating)=>({"unknown":0,"weak":1,"adequate":2,"strong":3}[v]);
const clean=(s:unknown):s is string=>
  typeof s==="string"&&!!s.trim()&&s.length<=1000&&!/[\0\r]/.test(s);

/** This read-only inspection is not the original extension execution engine.
 * Actual original Assess commands run in the Main Agent predevelopment phase.
 */
export async function inspectSpecKitAssessment(input:{
  root:string;intake:IntakeContract;
  stageProofs:OriginalScenarioStageEvidence[];
  verifyStage:OriginalScenarioVerifier;
  decision?:AssessmentDecision;
  verifyDecision?:VerifyAssessmentDecision;
  upstreamRoot?:string;
}):Promise<AssessmentResult>{
  const {intake,root}=input;
  if(intake.scenario!=="assessment"||intake.artifacts?.scenario!=="assess" ||
      !Array.isArray(input.stageProofs)||!input.verifyStage)
    throw new Error("Assessment requires original Spec Kit Assess contract");
  const approved=await decideIntake(intake,{projectRoot:root});
  if(approved.status!=="assessment_only")
    throw new Error("Assessment must not enter an implementation Issue");
  const report=(status:AssessmentResult["status"],nextOriginalCommand:string|null,
    completedStages:string[],blockers:string[],verdict:AssessmentVerdict|null=null,
    recommendation?:string):AssessmentResult=>({
    kind:"read_only_assessment",status,verdict,nextOriginalCommand,
    completedStages,blockers,requiresNewFeatureApproval:status==="go_candidate",
    mayCreateIssue:false,mayCreatePr:false,mayRunRunner:false,
    ...(recommendation?{recommendation}:{})});
  const contract=intake.artifacts;
  const order=["intake","research","problem","concept","decision"] as const;
  const evidence=input.stageProofs;
  if(evidence.length>order.length ||
      new Set(evidence.map(x=>x.stage)).size!==evidence.length ||
      evidence.some((x,i)=>order.indexOf(x.stage as typeof order[number])<
        (i===0?0:order.indexOf(evidence[i-1]!.stage as typeof order[number])) ||
        !order.includes(x.stage as typeof order[number])))
    throw new Error("Original assessment stages are duplicated/out of order");
  const seen=new Set<string>();
  for(const proof of evidence){
    await verifyScenarioStage(root,contract,"assess",proof.stage,proof,
      input.verifyStage,input.upstreamRoot);
    seen.add(proof.stage);
  }
  if(!seen.has("problem"))
    return report("needs_artifacts","speckit.assess.define",Array.from(seen),
      ["Original problem.md required before a decision"]);
  if(!seen.has("decision"))
    return report("ready_for_decision","speckit.assess.decide",Array.from(seen),[]);
  const decision=input.decision;
  if(!decision || !input.verifyDecision)
    throw new Error("Original assessment verdict needs independently verified decision");
  if(!["go","needs-clarification","kill"].includes(decision.verdict) ||
      !clean(decision.rationale)|| !/^[A-Za-z0-9_.:-]{6,120}$/.test(decision.sourceRef)||
      !Array.isArray(decision.scorecard)||decision.scorecard.length!==criteria.length||
      !Array.isArray(decision.evidence)||decision.evidence.length>40||
      !Array.isArray(decision.openQuestions))
    throw new Error("Malformed original assessment decision");
  if(new Set(decision.scorecard.map(x=>x.criterion)).size!==criteria.length ||
      criteria.some(c=>!decision.scorecard.some(x=>x.criterion===c)) ||
      decision.scorecard.some(x=>!["strong","adequate","weak","unknown"].includes(x.rating) ||
        !clean(x.rationale)||!Array.isArray(x.evidenceRefs)))
    throw new Error("Original assessment scorecard incomplete");
  for(const e of decision.evidence){
    if(!clean(e.title)||!clean(e.source) ||
        !["high","medium","low","assumption"].includes(e.confidence) ||
        typeof e.supports!=="boolean")
      throw new Error("Invalid assessment source or confidence");
  }
  const sources=new Map(decision.evidence.map(x=>[x.title,x]));
  if(sources.size!==decision.evidence.length ||
      decision.scorecard.some(s=>s.evidenceRefs.some(ref=>!sources.has(ref))))
    throw new Error("Assessment score references missing or duplicate sources");
  if(!await input.verifyDecision(decision,{issue:contract.task.issue,
      verdict:decision.verdict,artifactCommit:contract.commit}))
    throw new Error("Assessment conclusion not independently verified");
  const score=(c:AssessmentScore["criterion"])=>
    decision.scorecard.find(x=>x.criterion===c)!;
  if(decision.verdict==="go"){
    if(!seen.has("concept")||!seen.has("research")||
        !decision.recommendedOption||!clean(decision.recommendedOption)||
        !decision.potentialFeatureScope?.length ||
        strength(score("problem-validity").rating)<2||
        strength(score("evidence-strength").rating)<2 ||
        !score("evidence-strength").evidenceRefs.some(ref=>
          sources.get(ref)?.confidence!=="assumption" &&
          sources.get(ref)?.supports))
      throw new Error("Insufficient original concept/evidence for assessment GO");
    return report("go_candidate",null,Array.from(seen),[],decision.verdict,
      decision.rationale);
  }
  if(decision.verdict==="needs-clarification" &&
      (!decision.openQuestions.length ||
       decision.openQuestions.some(x=>!clean(x))))
    throw new Error("Clarification needs concrete blocking questions");
  return report(decision.verdict==="kill"?"kill":"clarify",null,
    Array.from(seen),[],decision.verdict,decision.rationale);
}
