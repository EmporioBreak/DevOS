import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {inspectDevos2ReleaseReadiness,inspectDevos2PostReleaseEvidence,type VerifiedLiveGate,
  type ProductionBackupProof,type LiveReleaseProvider} from "../src/devos2-release-readiness.js";

const projectRoot=process.cwd(), stagingSha="e".repeat(40);
const matrix=JSON.parse(await readFile(
  "config/devos-v2-acceptance-matrix.json","utf8"));
const pending=matrix.entries.filter((x:{status:string;liveIssue:number})=>
 x.status==="live_pending"&&x.liveIssue!==154) as
 Array<{id:string;liveIssue:number}>;
const gates=():VerifiedLiveGate[]=>pending.map(x=>({
 id:x.id,issue:x.liveIssue,stagingSha,
 testRun:"signed-local-run-for-"+x.id,
 status:"passed" as const,sourceRef:"provider-attested-"+x.id,
}));
const backup=():ProductionBackupProof=>({
 productionSha:"a".repeat(40),backupId:"verified-private-backup-01",
 sourceRef:"host-restoration-proof-01",restoreDryRunVerified:true,
 productionResourceFingerprint:"prod-oauth-resource-sha256",
 components:["config","oauth","sessions","state","browser_profile","executable"],
});
const provider:LiveReleaseProvider={
 async verifyGate(actual,expect){return actual.sourceRef===
    "provider-attested-"+expect.criterion &&
   actual.issue===expect.issue && actual.stagingSha===expect.stagingSha;},
 async verifyBackup(actual,sha){return actual.sourceRef==="host-restoration-proof-01" &&
    sha===stagingSha&&actual.restoreDryRunVerified;},
};

test("DevOS 2 current live release gate remains BLOCKED with no authenticated evidence",async()=>{
 const report=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha});
 assert.equal(report.status,"blocked");
 assert.equal(report.verified,0);
 assert.equal(report.tracked,9);
 assert.deepEqual(report.postReleasePending,["LIVE-PRODUCTION-GATE","LIVE-OWNER-REPORT"]);
 assert.ok(report.blockers.length>=report.tracked+1);
 assert.equal(report.manualReleaseDecisionRequired,true);
 assert.equal(report.mayMerge,false);
 assert.equal(report.mayTouchProduction,false);
 assert.equal(report.mayCloseEpic,false);
 assert.equal(report.backupVerified,false);
});

test("fake model self-report or stale SHA never unlocks Production",async()=>{
 const fake=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   gates:gates(),backup:backup()});
 assert.equal(fake.status,"blocked");
 assert.equal(fake.verified,0);
 const stale=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:gates().map(x=>({...x,stagingSha:"b".repeat(40)})),
   backup:backup()});
 assert.equal(stale.status,"blocked");
 assert.ok(stale.blockers.some(x=>x.includes("Unverified/stale")));
 assert.equal(stale.mayMerge,false);
 const invalidBackup=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:gates(),backup:{...backup(),restoreDryRunVerified:false}});
 assert.equal(invalidBackup.status,"blocked");
 assert.ok(invalidBackup.blockers.some(x=>x.includes("restore proof")));
});

test("all provider-attested stage proofs yield owner decision required, never automatic merge",async()=>{
 const ready=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:gates(),backup:backup()});
 assert.equal(ready.status,"ready_for_owner_release_decision");
 assert.equal(ready.verified,ready.tracked);
 assert.equal(ready.backupVerified,true);
 assert.equal(ready.manualReleaseDecisionRequired,true);
 assert.equal(ready.mayMerge,false);
 assert.equal(ready.mayTouchProduction,false);
 assert.equal(ready.mayCloseEpic,false);
});

test("missing mobile result, fabricated ID, duplicate evidence and unsafe release labels fail closed",async()=>{
 const incomplete=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:gates().filter(x=>x.id!=="LIVE-WEB-IOS"),backup:backup()});
 assert.equal(incomplete.status,"blocked");
 assert.match(incomplete.blockers.join(" "),/LIVE-WEB-IOS/);
 await assert.rejects(inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:[...gates(),gates()[0]!],backup:backup()}),/Invalid independent live release evidence count|duplicate/);
 const corrupted=gates();
 corrupted[0]={...corrupted[0]!,issue:999};
 await assert.rejects(inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:corrupted,backup:backup()}),/Invalid or duplicate live release evidence/);
 const labels=gates();
 labels[0]={...labels[0]!,testRun:"secret\ntoken="};
 await assert.rejects(inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:labels,backup:backup()}),/Invalid or duplicate/);
 const unexpected=gates();
 unexpected[0]={...unexpected[0]!,id:"LIVE-FORGED"};
 await assert.rejects(inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:unexpected,backup:backup()}),/unexpected live criterion/);
});

test("release cannot pass without all six private backup components and tested restore",async()=>{
 const missing=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:gates(),backup:{
    ...backup(),components:["config","oauth","sessions","state","executable"],
   }});
 assert.equal(missing.status,"blocked");
 assert.equal(missing.backupVerified,false);
 const wrongKey=await inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   provider,gates:gates(),backup:{...backup(),sourceRef:"model-says-backup-good"}});
 assert.equal(wrongKey.status,"blocked");
});

test("release matrix validation still rejects counterfeit automated evidence",async()=>{
 const altered=structuredClone(matrix);
 altered.entries.find((x:{id:string})=>x.id==="BROWSER-NO-REPLAY").evidence[0].name="fake green";
 await assert.rejects(inspectDevos2ReleaseReadiness({projectRoot,stagingSha,
   matrix:altered}),/Evidence test is absent/);
});

test("actual post-release evidence is independent and never authorizes automatic Epic closure",async()=>{
 const post=matrix.entries.filter((x:{liveIssue?:number})=>x.liveIssue===154);
 const proofs:VerifiedLiveGate[]=post.map((x:{id:string})=>({
  id:x.id,issue:154,stagingSha,status:"passed",testRun:"production-host-smoke-123",
  sourceRef:"provider-attested-"+x.id,
 }));
 const before=await inspectDevos2PostReleaseEvidence({projectRoot,stagingSha});
 assert.equal(before.status,"blocked");
 assert.equal(before.tracked,2);
 assert.equal(before.mayCloseEpic,false);
 const fake=await inspectDevos2PostReleaseEvidence({projectRoot,stagingSha,gates:proofs});
 assert.equal(fake.status,"blocked");
 const ready=await inspectDevos2PostReleaseEvidence({projectRoot,stagingSha,
  gates:proofs,provider});
 assert.equal(ready.status,"ready_for_owner_epic_review");
 assert.equal(ready.verified,2);
 assert.equal(ready.mayCloseEpic,false);
 assert.equal(ready.humanFinalReviewRequired,true);
});
