import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSkillDelivery, type VerifiedWorkerIdentity } from "../src/browser-skill-delivery.js";
import { DevosToolRegistry } from "../src/mcp-tools/registry.js";
import { resolveWorkerSkills, saveWorkerSkillManifest,
  readWorkerSkillManifest, type WorkerSkillContext } from "../src/skill-policy.js";

const ownerSecret="local-test-owner-secret-".repeat(3);
const upstreamRoot=join(homedir(),".devos-staging","upstream");
const options={
  library:JSON.parse(await readFile("config/devos-skills.json","utf8")),
  qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
  stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
  roots:{projectRoot:process.cwd(),upstreamRoot,
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}},
};
const taskContext=(issue:number,candidates:string[]):WorkerSkillContext=>({
  repo:"EmporioBreak/DevOS",issue,workerId:"developer",role:"developer",
  phase:"execution",specKitStage:"implement",optionalCandidates:candidates,
});
const verified=(issue:number):VerifiedWorkerIdentity=>({
  repo:"EmporioBreak/DevOS",issue,workerId:"developer",turn:1,
});
const tdd="superpowers-test-driven-development";
const debugging="superpowers-systematic-debugging";
const policy={version:1 as const,rules:[]};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-browser-skills-"));
  await mkdir(join(root,"config"),{recursive:true});
  for(const name of ["devos-skills.json","devos-upstreams.lock.json",
      "devos-speckit-stage-pins.json"]){
    await cp(join("config",name),join(root,"config",name));
  }
  await mkdir(join(root,".agents","skills","speckit-implement"),{recursive:true});
  await cp(".agents/skills/speckit-implement/SKILL.md",
    join(root,".agents","skills","speckit-implement","SKILL.md"));
  return root;
}
const freeze=async(root:string,issue:number,candidates:string[],secret=ownerSecret)=>{
  const manifest=await resolveWorkerSkills(taskContext(issue,candidates),policy,options);
  await saveWorkerSkillManifest(root,manifest,secret);
  return manifest;
};

test("two independent tasks get only their pinned original Spec Kit and Superpowers skills",async()=>{
  const root=await fixture();
  try{
    await freeze(root,201,[tdd,"superpowers-verification-before-completion"]);
    await freeze(root,202,[debugging]);
    const svc=new BrowserSkillDelivery(root,ownerSecret,upstreamRoot);
    const one=await svc.list(verified(201));
    const two=await svc.list(verified(202));
    assert.deepEqual(one.map(s=>s.id),[
      "speckit-implement",tdd,"superpowers-verification-before-completion",
    ]);
    assert.deepEqual(two.map(s=>s.id),["speckit-implement",debugging]);
    assert.equal(one.find(s=>s.id===tdd)?.version,"6.4.2");
    assert.deepEqual((await svc.search(verified(201),"test-driven")).map(s=>s.id),[tdd]);
    assert.deepEqual((await svc.search(verified(202),"test-driven")).map(s=>s.id),[]);
    const origin=await svc.read(verified(201),"speckit-implement","SKILL.md");
    assert.equal(origin.version,"1.1.2");
    assert.match(origin.content,/Execute the implementation plan/);
    const manual=await svc.read(verified(201),tdd,"writing-good-tests.md");
    assert.equal(manual.encoding,"utf8");
    assert.equal(manual.read_only,true);
    assert.equal(manual.execution_allowed,false);
    assert.ok(manual.bytes>100);
    const script=await svc.read(verified(202),debugging,"find-polluter.sh");
    assert.equal(script.execution_allowed,false);
    assert.match(script.content,/\S+/);
    await assert.rejects(svc.read(verified(202),tdd,"SKILL.md"),/not assigned/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("worker tool registry cannot trust task, role or session IDs provided by a model",async()=>{
  const root=await fixture();
  try {
    await freeze(root,211,[debugging]);
    const registry=new DevosToolRegistry(root,ownerSecret);
    for(const tool of ["devos_skill_manifest","devos_skill_search","devos_skill_read"])
      assert.ok(registry.list().some(x=>x.name===tool));
    const noIdentity=await registry.call("devos_skill_manifest",{});
    assert.equal(noIdentity.isError,true);
    assert.match(noIdentity.content[0]!.text,/server-verified active/);
    const spoof=await registry.call("devos_skill_manifest",{
      repo:"EmporioBreak/DevOS",issue:211,worker_id:"developer",
    });
    assert.equal(spoof.isError,true);
    const legitimate=await registry.call("devos_skill_manifest",{},verified(211));
    assert.equal(legitimate.isError,undefined);
    assert.match(JSON.stringify(legitimate.structuredContent),/systematic-debugging/);
    const wrongTask=await registry.call("devos_skill_manifest",{},verified(212));
    assert.equal(wrongTask.isError,true);
    const read=await registry.call("devos_skill_read",{
      skill_id:debugging,resource:"root-cause-tracing.md",
    },verified(211));
    assert.equal(read.isError,undefined);
    assert.match(JSON.stringify(read),/root-cause-tracing/);
    const traversal=await registry.call("devos_skill_read",{
      skill_id:debugging,resource:"../../private/.env",
    },verified(211));
    assert.equal(traversal.isError,true);
    const missing=await registry.call("devos_skill_read",{
      skill_id:debugging,resource:"not-an-upstream-file.md",
    },verified(211));
    assert.equal(missing.isError,true);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("unsigned or altered task assignment and wrong secret deny all content",async()=>{
  const root=await fixture();
  try {
    await freeze(root,220,[tdd]);
    const svc=new BrowserSkillDelivery(root,ownerSecret,upstreamRoot);
    assert.equal((await svc.list(verified(220))).length,2);
    const wrong=new BrowserSkillDelivery(root,"different-host-secret-".repeat(3),upstreamRoot);
    await assert.rejects(wrong.list(verified(220)),/MAC integrity/);
    const path=join(root,".devos","skills","assignments",
      "EmporioBreak%2FDevOS","220","developer.json");
    const envelope=JSON.parse(await readFile(path,"utf8"));
    envelope.manifest.selected[0].id=debugging;
    await writeFile(path,JSON.stringify(envelope));
    await assert.rejects(svc.list(verified(220)),/MAC integrity/);
    await assert.rejects(readWorkerSkillManifest(root,{repo:"EmporioBreak/DevOS",issue:220},
      "developer",ownerSecret),/MAC integrity/);
    const unsigned=await resolveWorkerSkills(taskContext(222,[tdd]),policy,options);
    await saveWorkerSkillManifest(root,unsigned);
    await assert.rejects(svc.list(verified(222)),/Signed worker skill assignment required/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("tampered upstream file or original Spec Kit instructions are refused",async()=>{
  const root=await fixture();
  try{
    await freeze(root,230,[tdd]);
    const svc=new BrowserSkillDelivery(root,ownerSecret,upstreamRoot);
    const path=join(root,".agents","skills","speckit-implement","SKILL.md");
    await writeFile(path,"rewritten SDD implement skill");
    await assert.rejects(svc.list(verified(230)),/integrity failed/);
    await assert.rejects(svc.read(verified(230),"speckit-implement","SKILL.md"),/integrity failed/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("upstream reference mutation is rejected without modifying the vendor source",async()=>{
  const root=await fixture();
  const upstream=await mkdtemp(join(tmpdir(),"devos-upstream-resource-"));
  try{
    await freeze(root,240,[tdd]);
    await mkdir(join(upstream,"superpowers","skills"),{recursive:true});
    await cp(join(upstreamRoot,"superpowers","skills","test-driven-development"),
      join(upstream,"superpowers","skills","test-driven-development"),{recursive:true});
    const svc=new BrowserSkillDelivery(root,ownerSecret,upstream);
    const intact=await svc.read(verified(240),tdd,"writing-good-tests.md");
    assert.equal(intact.read_only,true);
    await writeFile(join(upstream,"superpowers","skills",
      "test-driven-development","writing-good-tests.md"),"tampered");
    await assert.rejects(svc.read(verified(240),tdd,"writing-good-tests.md"),
      /integrity|drift/);
  }finally {
    await rm(root,{recursive:true,force:true});
    await rm(upstream,{recursive:true,force:true});
  }
});

test("existing worker refuses a silently updated catalog version rather than serving a different skill",async()=>{
  const root=await fixture();
  try{
    await freeze(root,245,[tdd]);
    const svc=new BrowserSkillDelivery(root,ownerSecret,upstreamRoot);
    assert.ok((await svc.list(verified(245))).some(s=>s.id===tdd));
    const catalog=JSON.parse(await readFile(join(root,"config","devos-skills.json"),"utf8"));
    catalog.skills.find((x:{id:string})=>x.id===tdd).version="6.5.0";
    await writeFile(join(root,"config","devos-skills.json"),JSON.stringify(catalog));
    await assert.rejects(svc.list(verified(245)),/differs from pinned library/);
  }finally{await rm(root,{recursive:true,force:true})}
});
