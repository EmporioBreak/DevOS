import { createHash } from "node:crypto";
import { verifySpecKitArtifactRevision, validateSpecKitContract,
  type SpecKitArtifactContract } from "./spec-kit-contract.js";

export type IntakeScenario = "feature" | "change" | "bugfix" | "assessment";
export type IntakeSize = "architectural" | "bounded" | "spike";
export type IntakeState = "discovery" | "needs_owner_review" | "approved_for_issue" |
  "assessment_only" | "scope_change_blocked";
export type ApprovalKind = "scope" | "spec" | "plan";

export interface IntakeRequest {
  text:string;
  /** Main Agent may explicitly determine scenario using project context. */
  scenario?:IntakeScenario;
  /** Main Agent decision: not inferred from short-text confidence. */
  size?:IntakeSize;
}
export interface IntakeChoice {
  id:string; benefits:string; risks:string;
}
export interface IntakeContract {
  version:1;
  scenario:IntakeScenario;
  size:IntakeSize;
  userGoal:string;
  userScenarios:string[];
  scope:string[];
  nonGoals:string[];
  acceptance:string[];
  options:IntakeChoice[];
  selectedOption?:string;
  /** For changed existing products, explicitly record its existing baseline. */
  existingProduct?:string;
  previousApprovalDigest?:string;
  /** Original Spec Kit canonical Git SHA, never a second Superpowers plan. */
  artifacts?:SpecKitArtifactContract;
}
export interface OwnerApprovalEvidence {
  /** Main Agent must obtain this through a trusted integration, not synthesize it. */
  userMessageRef:string;
  kind:ApprovalKind;
  /** Hash of the full exact agreed scope/artifact contract. */
  reviewedDigest:string;
}
export type TrustedApprovalVerifier = (evidence:OwnerApprovalEvidence,
  expected:{digest:string;kind:ApprovalKind}) => Promise<boolean>;

export interface IntakeDecision {
  status:IntakeState;
  scenario:IntakeScenario;
  size:IntakeSize;
  nextSteps:string[];
  approvalDigest:string;
  missing:string[];
  needsNewOwnerReview:boolean;
}
function hash(value:unknown):string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function text(s:unknown,name:string,max=4000):string {
  if (typeof s!=="string" || !s.trim() || s.length>max || /[\x00-\x08\x0e-\x1f]/.test(s))
    throw new Error("Missing or invalid intake "+name);
  return s.trim();
}
function distinct(items:unknown,name:string,min=0):string[] {
  if (!Array.isArray(items) || items.length<min || items.length>40)
    throw new Error("Invalid intake "+name);
  const valid=items.map(x=>text(x,name,700));
  if (new Set(valid).size!==valid.length) throw new Error("Duplicate intake "+name);
  return valid;
}

/** Conservative routing only. Ambiguous prompts are explicitly unresolved. */
export function classifyIntake(request:IntakeRequest):{
  scenario:IntakeScenario|null;size:IntakeSize|null;needsClarification:boolean;
} {
  const prompt=text(request.text,"request",8000);
  if (request.scenario && !["feature","change","bugfix","assessment"].includes(request.scenario))
    throw new Error("Unknown Main Agent scenario");
  if (request.size && !["architectural","bounded","spike"].includes(request.size))
    throw new Error("Unknown Main Agent intake size");
  const matches:IntakeScenario[]=[];
  if (/\b(?:assess|evaluate|compare ideas|feasibility|pros and cons)\b|(?:оцени|сравни концепц|оценк[ау]|проанализируй идею)/i.test(prompt))
    matches.push("assessment");
  if (/\b(?:bugfix|fix (?:a |the )?(?:bug|defect|error)|regression)\b|(?:исправ[ьи]|почини|баг|ошибк[уаие]|сломал)/i.test(prompt))
    matches.push("bugfix");
  if (/\b(?:redesign|change (?:the |a )?(?:homepage|layout|design)|update (?:the )?ui)\b|(?:редизайн|измени дизайн|переделай главн|обнови интерфейс)/i.test(prompt))
    matches.push("change");
  if (/\b(?:build (?:a |an )?(?:new )?(?:app|product|service)|create (?:a |an )?(?:new )?(?:app|product|service))\b|(?:создай (?:новое )?приложени|разработай (?:новый )?сервис)/i.test(prompt))
    matches.push("feature");
  const scenario=request.scenario??(new Set(matches).size===1?matches[0]!:null);
  const size=request.size??(scenario==="assessment"?"spike":
    scenario==="feature" || scenario==="change"?"architectural":
      scenario==="bugfix"?"bounded":null);
  return {scenario,size,needsClarification:!scenario||!size};
}

export function validateIntakeContract(value:IntakeContract):IntakeContract {
  if (!value || value.version!==1 ||
      !["feature","change","bugfix","assessment"].includes(value.scenario) ||
      !["architectural","bounded","spike"].includes(value.size))
    throw new Error("Unsupported Main Agent intake contract");
  const allowed=["version","scenario","size","userGoal","userScenarios","scope",
    "nonGoals","acceptance","options","selectedOption","existingProduct",
    "previousApprovalDigest","artifacts"];
  if (Object.keys(value).some(x=>!allowed.includes(x)))
    throw new Error("Unknown Main Agent intake fields");
  text(value.userGoal,"goal");
  distinct(value.userScenarios,"user scenarios",1);
  distinct(value.scope,"scope",1);
  distinct(value.nonGoals,"non goals");
  distinct(value.acceptance,"acceptance",1);
  if (!Array.isArray(value.options) || value.options.length>4 ||
      value.options.some(x=>!x||typeof x!=="object" ||
        Object.keys(x).some(k=>!["id","benefits","risks"].includes(k))))
    throw new Error("Invalid design alternatives");
  for (const option of value.options) {
    text(option.id,"option id",80);text(option.benefits,"option benefits");
    text(option.risks,"option risks");
  }
  if (new Set(value.options.map(x=>x.id)).size!==value.options.length)
    throw new Error("Duplicate design alternatives");
  if (value.size==="architectural" && (value.options.length<2 ||
      !value.selectedOption || !value.options.some(x=>x.id===value.selectedOption)))
    throw new Error("Architectural design requires compared options and selected choice");
  if (value.scenario==="change" && !value.existingProduct?.trim())
    throw new Error("Existing product baseline is required for redesign");
  if (value.scenario==="assessment" && value.artifacts?.scenario!=="assess")
    throw new Error("Assessment must reference canonical original Assess artifacts");
  if (value.scenario==="bugfix" && value.artifacts?.scenario!=="bugfix")
    throw new Error("Bugfix must reference canonical original Bugfix artifacts");
  if (["feature","change"].includes(value.scenario) &&
      value.artifacts?.scenario!=="feature")
    throw new Error("Feature/change must reference canonical original feature artifacts");
  if (value.artifacts) validateSpecKitContract(value.artifacts);
  if (value.previousApprovalDigest !== undefined &&
      !/^[0-9a-f]{64}$/.test(value.previousApprovalDigest))
    throw new Error("Previous approval digest must be an exact SHA-256");
  return value;
}
export function intakeDigest(contract:IntakeContract):string {
  const valid=validateIntakeContract(contract);
  const {previousApprovalDigest:_previous,...current}=valid;
  return hash(current);
}
/** Fail closed: a userMessageRef string alone does NOT authenticate approval.
 * This method requires a trusted independent verifier supplied by Main Agent.
 */
export async function decideIntake(contract:IntakeContract,opts:{
  approvals?:OwnerApprovalEvidence[];
  verifyApproval?:TrustedApprovalVerifier;
  projectRoot?:string;
}={}):Promise<IntakeDecision> {
  const valid=validateIntakeContract(contract);
  const digest=intakeDigest(valid);
  const hasNewScope=!!valid.previousApprovalDigest &&
    valid.previousApprovalDigest!==digest;
  if (!opts.projectRoot)
    throw new Error("Canonical Spec Kit artifact Git revision must be independently verified before Main Agent handoff");
  if (valid.artifacts)
    await verifySpecKitArtifactRevision(opts.projectRoot,valid.artifacts);
  const required:ApprovalKind[]=valid.scenario==="assessment"?[]:
    valid.size==="architectural"?["scope","spec","plan"]:["scope"];
  const missing:string[]=[];
  for (const kind of required) {
    const evidence=opts.approvals?.find(x=>x.kind===kind && x.reviewedDigest===digest);
    if (!evidence || typeof evidence.userMessageRef!=="string" || !evidence.userMessageRef ||
        !opts.verifyApproval) {
      missing.push(kind+" owner approval not independently verified");
      continue;
    }
    if (!await opts.verifyApproval(evidence,{digest,kind}))
      missing.push(kind+" owner approval rejected by trusted verifier");
  }
  // A materially changed revision must have NEW approvals bound to its new
  // digest. Valid newly verified approvals can authorize the changed scope.
  if (hasNewScope && missing.length)
    missing.push("material scope changed; new owner decision required");
  if (missing.length) return {status:hasNewScope?"scope_change_blocked":"needs_owner_review",
    scenario:valid.scenario,size:valid.size,approvalDigest:digest,missing,
    needsNewOwnerReview:true,nextSteps:["Return to Main Agent for the exact missing decision",
      "Do not launch DevOS Runner or treat owner silence as consent"]};
  if (valid.scenario==="assessment")
    return {status:"assessment_only",scenario:valid.scenario,size:valid.size,
      approvalDigest:digest,missing:[],needsNewOwnerReview:false,
      nextSteps:["Produce assessment and options","No Issue, PR or Runner unless separately approved"]};
  return {status:"approved_for_issue",scenario:valid.scenario,size:valid.size,
    approvalDigest:digest,missing:[],needsNewOwnerReview:false,
    nextSteps:["Publish exact contract and revision to GitHub Issue",
      "Freeze declared worker graph before Runner; no repeated worker consent"]};
}
