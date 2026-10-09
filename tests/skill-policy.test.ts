import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { parseSkillPolicy, updateSkillPreference, policyFingerprint,
  resolveWorkerSkills, readSkillPolicy, writeSkillPolicy,
  saveWorkerSkillManifest, readWorkerSkillManifest,
  type DevosSkillPolicy, type WorkerSkillContext } from "../src/skill-policy.js";
import type { SkillPreflightOptions } from "../src/skill-preflight.js";
const library = JSON.parse(await readFile("config/devos-skills.json", "utf8"));
const qualityPolicy = JSON.parse(await readFile("config/devos-quality-methods.json", "utf8"));
const stagePins = JSON.parse(await readFile("config/devos-speckit-stage-pins.json", "utf8"));
const options:SkillPreflightOptions = {
  library,qualityPolicy,stagePins,
  roots:{projectRoot:process.cwd(),upstreamRoot:join(homedir(),".devos-staging","upstream"),
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
const context:WorkerSkillContext = {
  repo:"EmporioBreak/DevOS",issue:351,workerId:"developer",
  role:"developer",phase:"execution",specKitStage:"implement",
  optionalCandidates:["superpowers-test-driven-development","superpowers-requesting-code-review"],
};
const empty:DevosSkillPolicy={version:1,rules:[]};
const tdd="superpowers-test-driven-development",verify="superpowers-verification-before-completion";

test("empty policy, zero requested skills, and explicit compatible optional selection", async () => {
  assert.deepEqual(parseSkillPolicy(empty),empty);
  const none=await resolveWorkerSkills({...context,optionalCandidates:[]},empty,options);
  assert.deepEqual(none.selected,[]);
  assert.deepEqual(none.skipped,[]);
  assert.equal(none.specKitStage,"implement");
  const found=await resolveWorkerSkills(context,empty,options);
  assert.deepEqual(found.selected.map(x=>x.id),[tdd]);
  assert.match(found.skipped[0]!.reason,/self-dispatch|graph/);
  assert.match(found.selected[0]!.rule,/default optional/);
  assert.match(found.sha256,/^[a-f0-9]{64}$/);
  assert.equal(found.sha256,(await resolveWorkerSkills(context,empty,options)).sha256);
});

test("precedence project > global, role > project, task > role is deterministic", async () => {
  const policy:DevosSkillPolicy={version:1,rules:[
    {scope:"global",skillId:tdd,mode:"off"},
    {scope:"project",context:"EmporioBreak/DevOS",skillId:tdd,mode:"optional"},
    {scope:"role",context:"developer",skillId:tdd,mode:"off"},
    {scope:"task",context:"EmporioBreak/DevOS#351",skillId:tdd,mode:"required"},
  ]};
  const current=await resolveWorkerSkills({...context,optionalCandidates:[]},policy,options);
  assert.equal(current.selected.length,1);
  assert.equal(current.selected[0]!.mode,"required");
  assert.equal(current.selected[0]!.rule,"task:EmporioBreak/DevOS#351");
  const other=await resolveWorkerSkills({...context,issue:352,optionalCandidates:[tdd]},policy,options);
  assert.deepEqual(other.selected,[]);
  assert.match(other.skipped[0]!.reason,/off at role/);
  const review=await resolveWorkerSkills({...context,issue:352,role:"reviewer",workerId:"reviewer",
    optionalCandidates:[tdd]},policy,options);
  assert.equal(review.selected[0]!.mode,"optional");
  assert.match(review.selected[0]!.rule,/project/);
  const external=await resolveWorkerSkills({...context,repo:"Other/Project",issue:352,role:"reviewer",workerId:"reviewer",
    optionalCandidates:[tdd]},policy,options);
  assert.match(external.skipped[0]!.reason,/off at global/);
});

test("required cannot be silently omitted; off is a hard exclusion even when requested", async () => {
  const req:DevosSkillPolicy={version:1,rules:[{scope:"global",skillId:verify,mode:"required"}]};
  const selected=await resolveWorkerSkills({...context,optionalCandidates:[]},req,options);
  assert.deepEqual(selected.selected.map(x=>x.id),[verify]);
  const denied:DevosSkillPolicy={version:1,rules:[
    {scope:"global",skillId:"superpowers-requesting-code-review",mode:"required"},
  ]};
  await assert.rejects(resolveWorkerSkills(context,denied,options),/self-dispatch|graph/);
  const noUse:DevosSkillPolicy={version:1,rules:[{scope:"global",skillId:tdd,mode:"off"}]};
  const skipped=await resolveWorkerSkills({...context,optionalCandidates:[tdd]},noUse,options);
  assert.deepEqual(skipped.selected,[]);
  assert.match(skipped.skipped[0]!.reason,/off/);
});

test("incompatible optional skills explain rejection without bypassing mandatory source check", async () => {
  const base:DevosSkillPolicy={version:1,rules:[{scope:"global",skillId:tdd,mode:"required"}]};
  const modifiedLibrary=structuredClone(library);
  modifiedLibrary.skills.find((x:any)=>x.id===verify).conflicts=[tdd];
  const result=await resolveWorkerSkills({...context,optionalCandidates:[verify]},base,
    {...options,library:modifiedLibrary});
  assert.deepEqual(result.selected.map(x=>x.id),[tdd]);
  assert.equal(result.skipped.length,1);
  assert.match(result.skipped[0]!.reason,/conflicting skills/);
  const blocked:DevosSkillPolicy={version:1,rules:[
    {scope:"global",skillId:verify,mode:"required"},
    {scope:"global",skillId:tdd,mode:"required"},
  ]};
  await assert.rejects(resolveWorkerSkills({...context,optionalCandidates:[]},blocked,
    {...options,library:modifiedLibrary}),/conflicting skills/);
});

test("policy parser validates contexts, duplicates, registry IDs and type-safe updates", () => {
  assert.throws(()=>parseSkillPolicy({version:1,rules:[
    {scope:"task",context:"../etc",skillId:tdd,mode:"off"},
  ]}),/context/);
  assert.throws(()=>parseSkillPolicy({version:1,rules:[
    {scope:"global",skillId:tdd,mode:"off"},
    {scope:"global",skillId:tdd,mode:"required"},
  ]}),/Duplicate/);
  assert.throws(()=>parseSkillPolicy({version:1,rules:[
    {scope:"role",context:"developer",skillId:tdd,mode:"inherit"},
  ]}),/Malformed/);
  assert.throws(()=>updateSkillPreference(empty,
    {scope:"global",skillId:"missing",mode:"required"},library),/Unknown/);
  const a=updateSkillPreference(empty,{scope:"global",skillId:tdd,mode:"off"},library);
  const b=updateSkillPreference(a,{scope:"global",skillId:tdd,mode:"required"},library);
  assert.equal(b.rules.length,1);
  assert.equal(b.rules[0]!.mode,"required");
  assert.equal(a.rules[0]!.mode,"off","immutable update");
});

test("Git-backed policy writes atomically, detects stale edit fingerprints and is reloadable", async () => {
  const fixture=await mkdtemp(join(tmpdir(),"devos-skills-policy-write-"));
  try {
    await mkdir(join(fixture,"config"),{recursive:true});
    await cp("config/devos-skill-policy.json",join(fixture,"config","devos-skill-policy.json"));
    const existing=await readSkillPolicy(fixture);
    const expected=policyFingerprint(existing);
    const next=updateSkillPreference(existing,{scope:"role",context:"developer",
      skillId:tdd,mode:"required"},library);
    const after=await writeSkillPolicy(fixture,next,expected);
    assert.equal(after,policyFingerprint(next));
    assert.deepEqual(await readSkillPolicy(fixture),next);
    await assert.rejects(writeSkillPolicy(fixture,existing,expected),/changed since/);
    await assert.rejects(writeSkillPolicy(fixture,existing,"bad-hash"),/Invalid expected/);
    const current=await readSkillPolicy(fixture);
    assert.equal((await resolveWorkerSkills({...context,optionalCandidates:[]},current,options))
      .selected[0]!.mode,"required");
    const lock = join(fixture,"config","devos-skill-policy.json.update.lock");
    await writeFile(lock, "another authorized request is writing");
    try {
      await assert.rejects(writeSkillPolicy(fixture,current,policyFingerprint(current)),
        /already in progress/);
    } finally {
      await rm(lock,{force:true});
    }
    assert.deepEqual(await readSkillPolicy(fixture),current);
    assert.equal((await writeSkillPolicy(fixture,current,policyFingerprint(current))),
      policyFingerprint(current));
  } finally {await rm(fixture,{recursive:true,force:true});}
});

test("registry-level policy errors and source drift fail explicitly", async () => {
  const invalid:DevosSkillPolicy={version:1,rules:[
    {scope:"global",skillId:"unregistered-new-feature",mode:"required"},
  ]};
  await assert.rejects(resolveWorkerSkills(context,invalid,options),/unknown registry/);
  const req:DevosSkillPolicy={version:1,rules:[
    {scope:"global",skillId:"devos-writing-plans",mode:"required"},
  ]};
  await assert.rejects(resolveWorkerSkills(context,req,options),/predevelopment-only/);
  await assert.rejects(resolveWorkerSkills({...context,
    optionalCandidates:[tdd,tdd]},empty,options),/Invalid worker/);
  await assert.rejects(resolveWorkerSkills({...context,
    workerId:"../../foo"},empty,options),/Invalid worker/);
});

test("per-worker skill assignments are frozen, idempotent and tamper-evident", async () => {
  const root=await mkdtemp(join(tmpdir(),"devos-skills-frozen-"));
  try {
    const selected=await resolveWorkerSkills(context,empty,options);
    const path=await saveWorkerSkillManifest(root,selected);
    assert.match(path,/developer\.json$/);
    assert.deepEqual(await readWorkerSkillManifest(root,selected.task,selected.workerId),selected);
    assert.equal(await saveWorkerSkillManifest(root,selected),path);
    const altered={...selected,role:"reviewer"};
    await assert.rejects(saveWorkerSkillManifest(root,altered),/hash mismatch/);
    const alternative=await resolveWorkerSkills({...context,optionalCandidates:[]},empty,options);
    await assert.rejects(saveWorkerSkillManifest(root,alternative),/already frozen/);
    assert.deepEqual(await readWorkerSkillManifest(root,selected.task,selected.workerId),selected);
    await writeFile(path,JSON.stringify({...selected,sha256:"0".repeat(64)}));
    await assert.rejects(readWorkerSkillManifest(root,selected.task,selected.workerId),
      /integrity mismatch/);
    await assert.rejects(readWorkerSkillManifest(root,selected.task,"../../danger"),
      /Invalid worker/);
  } finally {await rm(root,{recursive:true,force:true});}
});
