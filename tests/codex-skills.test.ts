import assert from "node:assert/strict";
import test from "node:test";
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { prepareCodexSkills } from "../src/codex-skills.js";
import { saveWorkerSkillManifest, resolveWorkerSkills } from "../src/skill-policy.js";
import { snapshotSkillDirectory } from "../src/skills-library.js";
import { CodexExecutor } from "../src/codex-executor.js";
import type { CommandRunner } from "../src/command-runner.js";

const secret="native-codex-owner-secret-".repeat(3);
const upstreamRoot=join(homedir(),".devos-staging","upstream");
const tdd="superpowers-test-driven-development",debugging="superpowers-systematic-debugging";
const lib=JSON.parse(await readFile("config/devos-skills.json","utf8"));
const options={
  library:lib,
  qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
  stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
  roots:{projectRoot:process.cwd(),upstreamRoot,
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
async function taskRoot() {
  const root=await mkdtemp(join(tmpdir(),"devos-codex-native-"));
  await mkdir(join(root,".agents","skills","speckit-implement"),{recursive:true});
  await cp(".agents/skills/speckit-implement/SKILL.md",
    join(root,".agents","skills","speckit-implement","SKILL.md"));
  await writeFile(join(root,".env"),"DEVOS_CONNECTOR_OWNER_SECRET="+secret+"\n",{mode:0o600});
  await mkdir(join(root,"config"),{recursive:true});
  for (const f of ["devos-skills.json","devos-upstreams.lock.json","devos-speckit-stage-pins.json"])
    await cp(join("config",f),join(root,"config",f));
  return root;
}
const ctx=(issue:number, workerId:string, skills:string[])=>({
  repo:"EmporioBreak/DevOS",issue,workerId,role:"developer",phase:"execution" as const,
  specKitStage:"implement",optionalCandidates:skills,
});
async function freeze(root:string,issue:number, workerId:string, skills:string[]) {
  const record=await resolveWorkerSkills(ctx(issue,workerId,skills),{version:1,rules:[]},options);
  await saveWorkerSkillManifest(root,record,secret);
  return record;
}
const scope=(issue:number,workerId="developer")=>({
  task:{repo:"EmporioBreak/DevOS",issue},workerId,mandatory:true,
});

test("original Spec Kit is preserved, selected Superpowers installed with nested assets",async()=>{
  const root=await taskRoot();
  try {
    await freeze(root,301,"developer",[tdd,debugging]);
    const officialBefore=await readFile(join(root,".agents","skills","speckit-implement","SKILL.md"));
    const installed=await prepareCodexSkills(root,scope(301),{ownerSecret:secret,upstreamRoot});
    assert.deepEqual(installed.installed,[tdd,debugging]);
    assert.equal(installed.specKitStage,"implement");
    assert.equal(installed.assigned,true);
    assert.deepEqual(await readFile(join(root,".agents","skills","speckit-implement","SKILL.md")),
      officialBefore);
    const a=lib.skills.find((x:{id:string})=>x.id===tdd);
    const b=lib.skills.find((x:{id:string})=>x.id===debugging);
    assert.deepEqual(await snapshotSkillDirectory(join(root,".agents","skills",tdd)),a.files);
    assert.deepEqual(await snapshotSkillDirectory(join(root,".agents","skills",debugging)),b.files);
    assert.ok((await readFile(join(root,".agents","skills",debugging,"root-cause-tracing.md"),"utf8")).length>20);
    assert.ok((await lstat(join(root,".agents","skills",debugging,"SKILL.md"))).isFile());
    assert.deepEqual((await prepareCodexSkills(root,scope(301),
      {ownerSecret:secret,upstreamRoot})).reused,[tdd,debugging]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("browser→Codex fallback keeps exact selected skill list without MCP retrieval",async()=>{
  const root=await taskRoot();
  try {
    const browser=await freeze(root,310,"browser_dev",[tdd]);
    const codex=await freeze(root,310,"codex_dev",[tdd]);
    assert.deepEqual(browser.selected.map(x=>[x.id,x.version]),
      codex.selected.map(x=>[x.id,x.version]));
    const calls:string[]=[];
    const runner:CommandRunner={
      async run(command,args,cwd) {
        assert.equal(command,"codex");assert.equal(cwd,root);
        assert.ok(args.length);
        calls.push(command);
        const native=await readFile(join(root,".agents","skills",tdd,"SKILL.md"),"utf8");
        assert.match(native,/Test-Driven Development/);
        const output=[
          {type:"thread.started",thread_id:"native-test-thread"},
          {type:"item.completed",item:{type:"agent_message",
            text:'DEVOS_RESULT {"status":"done"}'}},
          {type:"turn.completed",usage:{}},
        ].map(x=>JSON.stringify(x)).join("\n")+"\n";
        return {exitCode:0,stdout:output,stderr:""};
      },
    };
    const executor=new CodexExecutor(runner);
    const first=await executor.run({projectRoot:root,prompt:"test",workerId:"codex_dev",
      codexSkills:scope(310,"codex_dev")});
    assert.equal(first.sessionId,"native-test-thread");
    const second=await executor.run({projectRoot:root,prompt:"continuation",
      workerId:"codex_dev",sessionId:first.sessionId,
      codexSkills:scope(310,"codex_dev")});
    assert.equal(second.sessionId,first.sessionId);
    assert.equal(calls.length,2);
    assert.match((await readFile(join(root,".agents","skills",tdd,"writing-good-tests.md"),"utf8")),/\S/);
  } finally {await rm(root,{recursive:true,force:true})}
});

test("missing required signature, wrong secret, and unsigned assignment stop before Codex execution",async()=>{
  const root=await taskRoot();
  try {
    await assert.rejects(prepareCodexSkills(root,scope(320),
      {ownerSecret:secret,upstreamRoot}),/Required signed/);
    assert.deepEqual(await prepareCodexSkills(root,{...scope(320),mandatory:false},
      {ownerSecret:secret,upstreamRoot}),{assigned:false,installed:[],reused:[]});
    await freeze(root,321,"developer",[tdd]);
    await assert.rejects(prepareCodexSkills(root,scope(321),
      {ownerSecret:"different-owner-secret-longer-than-32",upstreamRoot}),/MAC integrity/);
    const record=await resolveWorkerSkills(ctx(322,"developer",[tdd]),{version:1,rules:[]},options);
    await saveWorkerSkillManifest(root,record);
    await assert.rejects(prepareCodexSkills(root,scope(322),
      {ownerSecret:secret,upstreamRoot}),/Signed worker skill assignment required/);
  } finally {await rm(root,{recursive:true,force:true})}
});

test("pre-existing user skill collision and replaced original Spec Kit fail closed without writes",async()=>{
  const root=await taskRoot();
  try {
    await freeze(root,330,"developer",[tdd]);
    await mkdir(join(root,".agents","skills",tdd));
    await writeFile(join(root,".agents","skills",tdd,"SKILL.md"),"# User custom implementation\n");
    await assert.rejects(prepareCodexSkills(root,scope(330),
      {ownerSecret:secret,upstreamRoot}),/collision|integrity|Invalid native/);
    assert.equal(await readFile(join(root,".agents","skills",tdd,"SKILL.md"),"utf8"),
      "# User custom implementation\n");
    const legacy=await readFile(join(root,".agents","skills","speckit-implement","SKILL.md"),"utf8");
    await writeFile(join(root,".agents","skills","speckit-implement","SKILL.md"),"bad override");
    await assert.rejects(prepareCodexSkills(root,scope(330),
      {ownerSecret:secret,upstreamRoot}),/integrity failed/);
    assert.notEqual(legacy,"bad override");
  } finally {await rm(root,{recursive:true,force:true})}
});

test("unsafe symlink parent and selected source revision mismatch block native install",async()=>{
  const root=await taskRoot();
  try {
    await freeze(root,340,"developer",[tdd]);
    await rm(join(root,".agents","skills"),{recursive:true});
    await symlink("/tmp",join(root,".agents","skills"));
    await assert.rejects(prepareCodexSkills(root,scope(340),
      {ownerSecret:secret,upstreamRoot}),/Unsafe native/);
  } finally {await rm(root,{recursive:true,force:true})}
  const another=await taskRoot();
  try {
    await freeze(another,341,"developer",[tdd]);
    const file=join(another,"config","devos-skills.json");
    const catalog=JSON.parse(await readFile(file,"utf8"));
    catalog.skills.find((x:{id:string})=>x.id===tdd).version="6.5.0";
    await writeFile(file,JSON.stringify(catalog));
    await assert.rejects(prepareCodexSkills(another,scope(341),
      {ownerSecret:secret,upstreamRoot}),/differs from pinned/);
  } finally {await rm(another,{recursive:true,force:true})}
});

test("user/global skill with the same SKILL.md name is never shadowed",async()=>{
  const root=await taskRoot();
  const personal=await mkdtemp(join(tmpdir(),"devos-user-skill-collision-"));
  try {
    await freeze(root,350,"developer",[tdd]);
    const existing=join(personal,"skills","personal-tdd");
    await mkdir(existing,{recursive:true});
    await writeFile(join(existing,"SKILL.md"),
      "---\nname: test-driven-development\ndescription: Private instructions\n---\n# Personal\n");
    await assert.rejects(prepareCodexSkills(root,scope(350),{
      ownerSecret:secret,upstreamRoot,userSkillDirectories:[join(personal,"skills")],
    }),/User\/global native Codex skill name collision/);
    await assert.rejects(readFile(join(root,".agents","skills",tdd,"SKILL.md")),
      /ENOENT/);
    assert.match(await readFile(join(existing,"SKILL.md"),"utf8"),/Private instructions/);
  } finally {
    await rm(root,{recursive:true,force:true});
    await rm(personal,{recursive:true,force:true});
  }
});
