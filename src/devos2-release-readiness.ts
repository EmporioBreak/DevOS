import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {verifyAcceptanceMatrix} from "./acceptance-matrix.js";

const SHA=/^[a-f0-9]{40}$/;
const TOKEN=/^[a-zA-Z0-9_.:-]{8,160}$/;
const LIVE=new Set([150,151,152,153,154]);
const safe=(s:unknown,max=500):s is string =>
  typeof s==="string"&&s.trim().length>0&&s.length<=max&&
  !/[\0\r\n]/.test(s);
export interface VerifiedLiveGate {
  id:string;issue:number;
  stagingSha:string;testRun:string;
  status:"passed";
  /** A provider-backed event identifier, not model narrative. */
  sourceRef:string;
}
export interface ProductionBackupProof{
  productionSha:string;
  /** This identifier must be private, never a backup path or secret in GitHub. */
  backupId:string;
  components:string[];
  restoreDryRunVerified:boolean;
  /** The actual current-production resource identity, compared by trusted host. */
  productionResourceFingerprint:string;
  sourceRef:string;
}
export interface LiveReleaseProvider{
  /** Must independently resolve real issue, tests and owner acceptance. */
  verifyGate(record:VerifiedLiveGate,expected:{
    criterion:string;issue:number;stagingSha:string;
  }):Promise<boolean>;
  verifyBackup(proof:ProductionBackupProof,stagingSha:string):Promise<boolean>;
}
export interface ReleaseReadiness{
  status:"blocked"|"ready_for_owner_release_decision";
  stagingSha:string|null;
  tracked:number;
  verified:number;
  /** Real post-deployment proofs can only be collected AFTER release. */
  postReleasePending:string[];
  /** Missing/pending live checks; never implicitly accepted. */
  blockers:string[];
  backupVerified:boolean;
  manualReleaseDecisionRequired:true;
  mayMerge:false;
  mayTouchProduction:false;
  mayCloseEpic:false;
}
export async function inspectDevos2ReleaseReadiness(input:{
  projectRoot:string;
  /** Exact pinned release candidate commit, not branch name. */
  stagingSha:string;
  gates?:VerifiedLiveGate[];
  backup?:ProductionBackupProof;
  provider?:LiveReleaseProvider;
  matrix?:unknown;
}):Promise<ReleaseReadiness>{
  const {projectRoot,stagingSha,provider}=input;
  const raw=input.matrix??JSON.parse(await readFile(
    join(projectRoot,"config","devos-v2-acceptance-matrix.json"),"utf8"));
  const check=await verifyAcceptanceMatrix(projectRoot,raw);
  // Pre-release #150-153 and post-release #154 cannot be the same gate:
  // requiring actual production verification before deployment deadlocks.
  const pending=check.matrix.entries.filter(x=>
    x.status==="live_pending" && x.liveIssue!==154);
  const afterRelease=check.matrix.entries.filter(x=>
    x.status==="live_pending" && x.liveIssue===154);
  if(!afterRelease.length || !pending.length)
    throw new Error("Release matrix must define pre- and post-release gates");
  const blockers:string[]=[];
  if(!SHA.test(stagingSha))blockers.push("Exact release candidate Git SHA not pinned");
  const records=input.gates??[];
  if(!Array.isArray(records)||records.length>pending.length)
    throw new Error("Invalid independent live release evidence count");
  const byId=new Map<string,VerifiedLiveGate>();
  for(const record of records){
    if(!record||typeof record!=="object"||
      !safe(record.id,100)||byId.has(record.id)||
      !LIVE.has(record.issue) || !SHA.test(record.stagingSha) ||
      !safe(record.testRun)||!TOKEN.test(record.sourceRef)||
      record.status!=="passed")
      throw new Error("Invalid or duplicate live release evidence");
    const criterion=pending.find(x=>x.id===record.id);
    if(!criterion || criterion.liveIssue!==record.issue)
      throw new Error("Release evidence refers to unexpected live criterion or Issue");
    byId.set(record.id,record);
  }
  let verified=0;
  for(const criterion of pending){
    const actual=byId.get(criterion.id);
    if(!actual){
      blockers.push("Missing independently verified live gate "+criterion.id+
        " (Issue #"+criterion.liveIssue+")");
      continue;
    }
    if(!provider||actual.stagingSha!==stagingSha||
       !await provider.verifyGate(actual,{
         criterion:criterion.id,issue:criterion.liveIssue!,stagingSha,
       })){
      blockers.push("Unverified/stale live gate "+criterion.id+
        " (Issue #"+criterion.liveIssue+")");
    }else verified++;
  }
  let backupVerified=false;
  const backup=input.backup;
  if(!backup){
    blockers.push("Missing private Production backup and restoration proof");
  }else if(!SHA.test(backup.productionSha) ||
      !TOKEN.test(backup.backupId) || !TOKEN.test(backup.sourceRef) ||
      !TOKEN.test(backup.productionResourceFingerprint) ||
      !backup.restoreDryRunVerified ||
      !Array.isArray(backup.components)||
      !["config","oauth","sessions","state","browser_profile","executable"].every(c=>
        backup.components.includes(c))||
      backup.components.some(c=>!safe(c,30))||
      !provider || !await provider.verifyBackup(backup,stagingSha)){
    blockers.push("Production backup or restore proof not independently verified");
  }else backupVerified=true;
  return {status:blockers.length?"blocked":"ready_for_owner_release_decision",
    stagingSha:SHA.test(stagingSha)?stagingSha:null,
    tracked:pending.length,verified,blockers,backupVerified,
    postReleasePending:afterRelease.map(x=>x.id),
    manualReleaseDecisionRequired:true,mayMerge:false,mayTouchProduction:false,
    mayCloseEpic:false};
}
/** Local diagnostics without passing fabricated E2E or production approvals. */
export async function explainCurrentReleaseBlockers(root:string,commit:string){
  return inspectDevos2ReleaseReadiness({
    projectRoot:root,stagingSha:commit,
  });
}

/** After a controlled release, require genuine new production smoke and
 * owner reporting before Main Agent may even consider Epic closure.
 * No release/merge/close action is exposed by this function.
 */
export async function inspectDevos2PostReleaseEvidence(input:{
  projectRoot:string;stagingSha:string;gates?:VerifiedLiveGate[];
  provider?:LiveReleaseProvider;matrix?:unknown;
}):Promise<{
  status:"blocked"|"ready_for_owner_epic_review";
  tracked:number;verified:number;blockers:string[];
  mayCloseEpic:false;humanFinalReviewRequired:true;
}>{
  const raw=input.matrix??JSON.parse(await readFile(join(input.projectRoot,
    "config","devos-v2-acceptance-matrix.json"),"utf8"));
  const check=await verifyAcceptanceMatrix(input.projectRoot,raw);
  const required=check.matrix.entries.filter(x=>x.status==="live_pending"&&
    x.liveIssue===154);
  const records=input.gates??[];
  if(!Array.isArray(records)||records.length>required.length ||
    new Set(records.map(x=>x.id)).size!==records.length)
    throw new Error("Invalid post-release gate evidence roster");
  const blockers:string[]=[];
  let verified=0;
  for(const item of required){
    const evidence=records.find(x=>x.id===item.id);
    if(!evidence||!SHA.test(input.stagingSha)||
       evidence.issue!==154||evidence.stagingSha!==input.stagingSha||
       evidence.status!=="passed"||!safe(evidence.testRun)||
       !TOKEN.test(evidence.sourceRef)||!input.provider||
       !await input.provider.verifyGate(evidence,{
          criterion:item.id,issue:154,stagingSha:input.stagingSha})){
      blockers.push("Missing trusted post-release proof "+item.id);
    }else verified++;
  }
  return {status:blockers.length?"blocked":"ready_for_owner_epic_review",
    tracked:required.length,verified,blockers,
    mayCloseEpic:false,humanFinalReviewRequired:true};
}
