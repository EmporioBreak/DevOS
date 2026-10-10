import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {verifyAcceptanceMatrix} from "../src/acceptance-matrix.js";

const root=process.cwd();
const source=JSON.parse(await readFile("config/devos-v2-acceptance-matrix.json","utf8"));

test("Epic 121 acceptance matrix maps every automated item to a real enabled regression test",async()=>{
  const report=await verifyAcceptanceMatrix(root,source);
  assert.ok(report.automated>=30);
  assert.ok(report.testRefs>=30);
  assert.ok(report.livePending>=10);
  assert.equal(report.automated+report.livePending,report.matrix.entries.length);
  assert.ok(report.matrix.entries.some(x=>x.id==="BROWSER-NO-REPLAY"));
  assert.ok(report.matrix.entries.some(x=>x.id==="RUNNER-LEGACY"));
  assert.ok(report.matrix.entries.some(x=>x.id==="RUNNER-CAPABILITY-GRAPH" &&
    x.evidence.some(e=>e.name.includes("Main Agent planned Codex action")) &&
    x.evidence.some(e=>e.name.includes("trusted host proof"))));
  assert.ok(report.matrix.entries.some(x=>x.id==="SKILLS-CODEX"));
});

test("live Web and Production isolation cannot be marked PASS by simulated tests",async()=>{
  const checked=await verifyAcceptanceMatrix(root,source);
  const pending=checked.matrix.entries.filter(x=>x.status==="live_pending");
  assert.ok(pending.every(x=>!!x.check&&!!x.liveIssue));
  assert.ok(pending.some(x=>x.liveIssue===151&&x.id==="LIVE-WEB"));
  assert.ok(pending.some(x=>x.liveIssue===151&&x.id==="LIVE-PRODUCTION-ISOLATION"));
  assert.ok(!pending.some(x=>x.id==="LIVE-STAGING-ISOLATION"));
  assert.ok(pending.some(x=>x.liveIssue===154&&x.id==="LIVE-PRODUCTION-GATE"));
  const fabricated=structuredClone(source);
  const i=fabricated.entries.findIndex((x:{id:string})=>x.id==="LIVE-WEB");
  fabricated.entries[i].status="automated";
  await assert.rejects(verifyAcceptanceMatrix(root,fabricated),
    /Automated acceptance cannot claim live result/);
});

test("missing evidence, poisoned filenames and fabricated/skipped test names fail closed",async()=>{
  const bad=structuredClone(source);
  bad.entries[0].evidence[0].name="an imaginary test that never ran";
  await assert.rejects(verifyAcceptanceMatrix(root,bad),/Evidence test is absent/);
  const traversal=structuredClone(source);
  traversal.entries[0].evidence[0].file="../../production/config.test.ts";
  await assert.rejects(verifyAcceptanceMatrix(root,traversal),/Unsafe regression evidence/);
  const removed=structuredClone(source);
  removed.entries=removed.entries.filter((x:{id:string})=>x.id!=="RUNNER-FIXED-GRAPH");
  await assert.rejects(verifyAcceptanceMatrix(root,removed),/Missing required Epic acceptance route/);
  const duplicate=structuredClone(source);
  duplicate.entries.push(duplicate.entries[0]);
  await assert.rejects(verifyAcceptanceMatrix(root,duplicate),/Malformed or duplicate/);
});

test("cross-component coverage contains all necessary original pathways and release blockers",async()=>{
  const report=await verifyAcceptanceMatrix(root,source);
  const ids=report.matrix.entries.map(x=>x.id);
  assert.equal(new Set(ids).size,ids.length);
  for(const category of ["OWNER","SDD","BUGFIX","ASSESS","SKILLS","RUNNER","MCP","BROWSER","CODEX","DIAG","LIVE"])
    assert.ok(ids.some(id=>id.startsWith(category+"-")),category);
  const followups=new Set(report.matrix.entries.filter(x=>x.status==="live_pending").map(x=>x.liveIssue));
  assert.deepEqual([...followups].sort(),[150,151,152,153,154]);
});


test("live matrix must not require retired Staging MCP, Cloudflare or copied OAuth",async()=>{
 const verified=await verifyAcceptanceMatrix(root,source);
 const web=verified.matrix.entries.find(x=>x.id==="LIVE-WEB")!;
 const isolation=verified.matrix.entries.find(x=>x.id==="LIVE-PRODUCTION-ISOLATION")!;
 assert.equal(web.status,"live_pending");
 assert.equal(isolation.status,"live_pending");
 assert.match(web.criterion,/Production DevOS MCP/);
 assert.match(isolation.check!,/distinct real host sessions/);
 assert.match(isolation.check!,/Staging MCP off/);
 assert.match(isolation.check!,/shared Camoufox identity/);
 for(const entry of [web,isolation]){
   assert.doesNotMatch(entry.criterion,/Staging plugin|Cloudflare resource|copied authentication/i);
   assert.equal(entry.liveIssue,151);
 }
 const obsolete=structuredClone(source);
 const bad=obsolete.entries.find((x:{id:string})=>x.id==="LIVE-PRODUCTION-ISOLATION");
 bad.criterion="Proof of distinct remote MCP/Cloudflare resource and copied authentication";
 await assert.rejects(verifyAcceptanceMatrix(root,obsolete),/Production-only MCP contract/);
 const fake=structuredClone(source);
 fake.entries.find((x:{id:string})=>x.id==="LIVE-WEB").status="automated";
 await assert.rejects(verifyAcceptanceMatrix(root,fake),/Automated acceptance cannot claim live result/);
});


test("owner manually tests iPhone; only Production Web is an agent E2E gate",async()=>{
 const result=await verifyAcceptanceMatrix(root,source);
 const pending=result.matrix.entries.filter(x=>x.status==="live_pending");
 assert.equal(pending.length,11);
 assert.ok(pending.some(x=>x.id==="LIVE-WEB"&&x.liveIssue===151));
 assert.ok(pending.every(x=>!(/LIVE-(IOS|IPHONE|WEB-IOS)/.test(x.id))));
 const web=pending.find(x=>x.id==="LIVE-WEB")!;
 assert.match(web.check!,/Native iPhone testing is explicitly outside/);
 const old=structuredClone(source);
 old.entries.find((x:{id:string})=>x.id==="LIVE-WEB").id="LIVE-WEB-IOS";
 await assert.rejects(verifyAcceptanceMatrix(root,old),/Missing required Epic acceptance route|reserved for the owner/);
 const fabricated=structuredClone(source);
 fabricated.entries.find((x:{id:string})=>x.id==="LIVE-WEB").status="automated";
 await assert.rejects(verifyAcceptanceMatrix(root,fabricated),/Automated acceptance cannot claim live result/);
});
