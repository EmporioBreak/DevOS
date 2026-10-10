import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getSkillsDiagnostics, previewSkillsUpdate } from "../src/skill-diagnostics.js";
import { parseSkillsCliArgs, runSkillsCliCommand } from "../src/skills-cli.js";
import { parseCliArgs } from "../src/cli.js";
import { DevosToolRegistry } from "../src/mcp-tools/registry.js";
import { resolveWorkerSkills, saveWorkerSkillManifest } from "../src/skill-policy.js";

const secret="local-diagnostic-secret-".repeat(3);
const upstreamRoot=join(homedir(),".devos-staging","upstream");
const library=JSON.parse(await readFile("config/devos-skills.json","utf8"));
const tdd="superpowers-test-driven-development",plan="superpowers-writing-plans";
const worker={repo:"EmporioBreak/DevOS",issue:411,workerId:"developer",role:"developer",
  phase:"execution" as const,specKitStage:"implement",
  optionalCandidates:[tdd]};
const opts={
  library,
  qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
  stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
  roots:{projectRoot:process.cwd(),upstreamRoot,
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-skills-diagnostics-"));
  await mkdir(join(root,"config"),{recursive:true});
  for(const name of ["devos-skills.json","devos-skill-policy.json",
    "devos-quality-methods.json","devos-upstreams.lock.json",
    "devos-speckit-stage-pins.json"])
    await cp(join("config",name),join(root,"config",name));
  await mkdir(join(root,".agents","skills","speckit-implement"),{recursive:true});
  await cp(".agents/skills/speckit-implement/SKILL.md",
    join(root,".agents","skills","speckit-implement","SKILL.md"));
  return root;
}
test("read-only Skills Library inventory contains 17 pinned entries and no secrets",async()=>{
  const report=await getSkillsDiagnostics(process.cwd(),{upstreamRoot});
  assert.equal(report.version,1);
  assert.equal(report.skills.length,17);
  assert.equal(report.totals.installed,17);
  assert.equal(report.totals.integrity_failed,0);
  assert.ok(report.upstream.some(x=>x.id==="superpowers" && /^[a-f0-9]{40}$/.test(x.commit)));
  assert.ok(report.skills.some(x=>x.id==="devos-writing-plans" && x.origin==="adapted"));
  const json=JSON.stringify(report);
  assert.doesNotMatch(json,/\/Users\/|\/private\/|DEVOS_CONNECTOR_OWNER_SECRET|auth_token|oauth-clients|password/);
  assert.ok(!("ownerSecret" in report));
});

test("read-only Issue diagnosis reports reproducible effective and signed frozen assignments",async()=>{
  const root=await fixture();
  try {
    const freeze=await resolveWorkerSkills(worker,{version:1,rules:[]},opts);
    await saveWorkerSkillManifest(root,freeze,secret);
    const report=await getSkillsDiagnostics(root,{ownerSecret:secret,context:worker,upstreamRoot});
    const issue=report.currentIssue!;
    assert.equal(issue.assignmentStatus,"verified");
    assert.equal(issue.effectiveStatus,"verified");
    assert.equal(issue.assignmentMatchesCurrentPolicy,true);
    assert.deepEqual(issue.frozen?.selected.map(x=>x.id),[tdd]);
    assert.deepEqual(issue.effective?.selected.map(x=>x.id),[tdd]);
    assert.equal(issue.frozen?.sha256,freeze.sha256);
    const repeat=await getSkillsDiagnostics(root,{ownerSecret:secret,context:worker,upstreamRoot});
    assert.deepEqual(repeat.currentIssue,report.currentIssue);
    const mismatched=await getSkillsDiagnostics(root,{ownerSecret:secret,
      context:{...worker,role:"reviewer"},upstreamRoot});
    assert.equal(mismatched.currentIssue?.assignmentStatus,"invalid");
    const newPreference=await getSkillsDiagnostics(root,{ownerSecret:secret,
      context:{...worker,optionalCandidates:[]},upstreamRoot});
    assert.equal(newPreference.currentIssue?.assignmentMatchesCurrentPolicy,false);
    const wrong=await getSkillsDiagnostics(root,{ownerSecret:"different-secret-longer-than-thirty-two",
      context:worker,upstreamRoot});
    assert.equal(wrong.currentIssue?.assignmentStatus,"invalid");
    assert.equal(wrong.currentIssue?.frozen,undefined);
    const anonymous=await getSkillsDiagnostics(root,{context:worker,upstreamRoot});
    assert.equal(anonymous.currentIssue?.assignmentStatus,"unverified");
  } finally {await rm(root,{recursive:true,force:true})}
});

test("upstream resource drift is discovered and sanitized rather than silently ignored",async()=>{
  const root=await fixture(),upstream=await mkdtemp(join(tmpdir(),"devos-diagnostics-upstream-"));
  try {
    await mkdir(join(upstream,"superpowers","skills"),{recursive:true});
    await cp(join(upstreamRoot,"superpowers","skills","test-driven-development"),
      join(upstream,"superpowers","skills","test-driven-development"),{recursive:true});
    const before=await getSkillsDiagnostics(root,{upstreamRoot:upstream});
    assert.equal(before.skills.find(x=>x.id===tdd)?.sourceStatus,"installed");
    const file=join(upstream,"superpowers","skills","test-driven-development","writing-good-tests.md");
    await writeFile(file,"tampered resource");
    const after=await getSkillsDiagnostics(root,{upstreamRoot:upstream});
    assert.equal(after.skills.find(x=>x.id===tdd)?.sourceStatus,"integrity_failed");
    assert.equal(after.skills.find(x=>x.id===tdd)?.advice.includes("stop"),true);
    assert.doesNotMatch(JSON.stringify(after),/\/private\/|devos-diagnostics-upstream-/);
  } finally {await rm(root,{recursive:true,force:true});await rm(upstream,{recursive:true,force:true})}
});

test("review-only upstream preview lists changed resources and required adaptation review",async()=>{
  const original=library.skills.find((x:{id:string})=>x.id===plan);
  const next=structuredClone(original);
  next.version="6.4.3";
  next.files["SKILL.md"]=createHash("sha256").update("candidate update").digest("hex");
  next.files["references/review.md"]=createHash("sha256").update("new file").digest("hex");
  const before=await readFile("config/devos-skills.json","utf8");
  const preview=await previewSkillsUpdate(process.cwd(),plan,next);
  assert.equal(preview.releaseReady,false);
  assert.deepEqual(preview.changed,["SKILL.md"]);
  assert.deepEqual(preview.added,["references/review.md"]);
  assert.deepEqual(preview.adaptationsToReview,["devos-writing-plans"]);
  assert.ok(preview.releaseBlocks.some(x=>/adapted skills/.test(x)));
  assert.match(preview.reviewFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(await readFile("config/devos-skills.json","utf8"),before);
  await assert.rejects(previewSkillsUpdate(process.cwd(),plan,{
    ...next,version:original.version,
  }),/version bump/);
});

test("CLI parses read-only status, Issue resolution and change preview without changing run syntax",async()=>{
  assert.deepEqual(parseCliArgs(["skills","status"]),{kind:"skills",command:{action:"status"}});
  assert.equal(parseCliArgs(["run","41"]).kind,"run");
  assert.equal(parseSkillsCliArgs(["issue",worker.repo,String(worker.issue),worker.workerId,
    worker.role,worker.phase,worker.specKitStage!,tdd]).action,"issue");
  assert.throws(()=>parseSkillsCliArgs(["issue",worker.repo,"../../sensitive","dev",
    "developer","execution","implement"]),/Usage/);
  const status=JSON.parse(await runSkillsCliCommand({action:"status"},process.cwd()));
  assert.equal(status.skills.length,17);
  const dir=await mkdtemp(join(tmpdir(),"devos-preview-file-"));
  try{
    const candidate=structuredClone(library.skills.find((x:{id:string})=>x.id===plan));
    candidate.version="6.4.3";candidate.files["SKILL.md"]="f".repeat(64);
    const path=join(dir,"candidate.json");
    await writeFile(path,JSON.stringify(candidate));
    const output=JSON.parse(await runSkillsCliCommand({
      action:"preview",skillId:plan,candidateFile:path,
    },process.cwd()));
    assert.equal(output.releaseReady,false);
    assert.deepEqual(output.changed,["SKILL.md"]);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test("MCP owner diagnostic and update preview tools are structured read-only and reject malformed args",async()=>{
  const registry=new DevosToolRegistry(process.cwd(),secret);
  for (const name of ["devos_skill_diagnostics","devos_skill_update_preview"]) {
    const tool=registry.list().find(x=>x.name===name);
    assert.ok(tool);
    assert.equal((tool.annotations as Record<string,unknown>).readOnlyHint,true);
  }
  const first=await registry.call("devos_skill_diagnostics",{});
  assert.equal(first.isError,undefined);
  assert.equal((first.structuredContent?.skills as unknown[]).length,17);
  const bad=await registry.call("devos_skill_diagnostics",{repo:"EmporioBreak/DevOS"});
  assert.equal(bad.isError,true);
  const candidate=structuredClone(library.skills.find((x:{id:string})=>x.id===plan));
  candidate.version="6.4.3";candidate.files["SKILL.md"]="f".repeat(64);
  const next=await registry.call("devos_skill_update_preview",{
    skill_id:plan,candidate_json:JSON.stringify(candidate)});
  assert.equal(next.isError,undefined);
  assert.equal(next.structuredContent?.releaseReady,false);
  assert.deepEqual(next.structuredContent?.adaptationsToReview,["devos-writing-plans"]);
  const unsafe=await registry.call("devos_skill_update_preview",{
    skill_id:plan,candidate_json:"{invalid json"});
  assert.equal(unsafe.isError,true);
  assert.doesNotMatch(JSON.stringify(first),/DEVOS_CONNECTOR_OWNER_SECRET|access_token|ownerSecret|\/Users\//);
});
