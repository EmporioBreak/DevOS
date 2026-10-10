import assert from "node:assert/strict";
import test from "node:test";
import {readFile,writeFile,mkdtemp,mkdir,cp,rm} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join} from "node:path";
import {appendTaskAuditEvent,readPipelineSnapshot} from "../src/pipeline-diagnostics.js";
import {JsonStateStore} from "../src/json-state-store.js";
import {resolveWorkerSkills,saveWorkerSkillManifest} from "../src/skill-policy.js";
import {DevosToolRegistry} from "../src/mcp-tools/registry.js";
import {ChatSendQueueStore} from "../src/chat-send-queue.js";

const task={repo:"EmporioBreak/DevOS",issue:748,pr:930};
const key="pipeline-owner-key-strong-".repeat(3);
const tdd="superpowers-test-driven-development";
test("pipeline snapshot exposes task send readiness and unknown global busy without prompt or hashes",async()=>{
  const {root}=await fixture();
  try{
    const queue=new ChatSendQueueStore(root,{repo:task.repo,issue:task.issue,workerId:"developer",turn:2,
      turnTokenHash:"a".repeat(64),promptSha256:"b".repeat(64),conversationSha256:"c".repeat(64)});
    await queue.begin(); await queue.markReady();
    const result=await readPipelineSnapshot(root,task,key);
    assert.equal(result.sendQueue[0]?.status,"ready_to_send");
    assert.equal(result.sendQueue[0]?.globalBusy,"unknown");
    assert.equal(JSON.stringify(result).includes("a".repeat(64)),false);
    assert.equal(JSON.stringify(result).includes("b".repeat(64)),false);
  }finally{await rm(root,{recursive:true,force:true})}
});
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"devos-pipeline-audit-"));
  await mkdir(join(root,"config"),{recursive:true});
  for(const f of ["devos-skills.json","devos-skill-policy.json",
    "devos-quality-methods.json","devos-speckit-stage-pins.json",
    "devos-upstreams.lock.json"])
    await cp(join("config",f),join(root,"config",f));
  const roots={projectRoot:process.cwd(),
    upstreamRoot:join(homedir(),".devos-staging","upstream"),
    upstreamPins:{superpowers:"8ca22dba9a94f28898bbce59f2537ff4d87c747d"}};
  const assignments={
    library:JSON.parse(await readFile("config/devos-skills.json","utf8")),
    qualityPolicy:JSON.parse(await readFile("config/devos-quality-methods.json","utf8")),
    stagePins:JSON.parse(await readFile("config/devos-speckit-stage-pins.json","utf8")),
    roots,
  };
  await mkdir(join(root,".agents","skills","speckit-implement"),{recursive:true});
  await cp(".agents/skills/speckit-implement/SKILL.md",
    join(root,".agents","skills","speckit-implement","SKILL.md"));
  const manifest=await resolveWorkerSkills({
    repo:task.repo,issue:task.issue,workerId:"developer",role:"developer",
    phase:"execution",specKitStage:"implement",optionalCandidates:[tdd],
  },{version:1,rules:[]},assignments);
  await saveWorkerSkillManifest(root,manifest,key);
  return {root,manifest};
}
test("task timeline retains only safe phase, skill version, review and source details",async()=>{
  const {root,manifest}=await fixture();
  try{
    await new JsonStateStore(root,task).save({
      currentWorkerId:"developer",completedRuns:2,
      mainAgentReviewPending:true,reviewLoops:1,
      sessions:{developer:"https://chatgpt.com/c/private-conversation"},
      activeReport:{workerId:"developer",turn:2,tokenHash:"a".repeat(64)},
      browserWorkersStarted:["developer"],
      task,
    });
    await appendTaskAuditEvent(root,task,{type:"task_status",task,status:"running"});
    await appendTaskAuditEvent(root,task,{
      type:"worker_started",workerId:"developer",executor:"chatgpt_browser",session:"resumed",
    });
    await appendTaskAuditEvent(root,task,{
      type:"worker_session_recovered",workerId:"developer",executor:"chatgpt_browser",
      reason:"Browser could not reconnect to https://chatgpt.com/c/private?token=ABC-secret"},
    );
    await appendTaskAuditEvent(root,task,{type:"main_agent_handoff",task});
    const snapshot=await readPipelineSnapshot(root,task,key);
    assert.equal(snapshot.state,"final_review_required");
    assert.equal(snapshot.reviewLoops,1);
    assert.equal(snapshot.turn,2);
    assert.equal(snapshot.workers[0]!.assignment,"verified");
    assert.equal(snapshot.workers[0]!.stage,"implement");
    assert.deepEqual(snapshot.workers[0]!.selected.map(s=>s.id),[tdd]);
    assert.equal(snapshot.workers[0]!.selected[0]!.version,manifest.selected[0]!.version);
    assert.equal(snapshot.events.length,4);
    assert.equal(snapshot.events[2]!.reason,"browser_session_recovery");
    assert.match(snapshot.blocker??"",/Unresolved active browser turn/);
    const json=JSON.stringify(snapshot);
    assert.doesNotMatch(json,/private-conversation|ABC-secret|tokenHash|sessions|\.devos\/state/);
    const mcp=await new DevosToolRegistry(root,key).call("devos_pipeline_status",{
      repo:task.repo,issue:task.issue});
    assert.equal(mcp.isError,undefined);
    assert.equal(mcp.structuredContent?.state,"final_review_required");
    assert.doesNotMatch(JSON.stringify(mcp),/private-conversation|ABC-secret/);
  } finally {await rm(root,{recursive:true,force:true})}
});
test("ownerless pipeline diagnostic never reveals signed skill or private auth values",async()=>{
  const {root}=await fixture();
  try{
    await appendTaskAuditEvent(root,task,{type:"worker_started",
      workerId:"developer",executor:"chatgpt_browser",session:"fresh"});
    const snapshot=await readPipelineSnapshot(root,task);
    assert.equal(snapshot.workers[0]!.assignment,"unverified");
    assert.deepEqual(snapshot.workers[0]!.selected,[]);
    assert.equal(snapshot.state,"not_started");
    const tool=await new DevosToolRegistry(root).call("devos_pipeline_status",
      {repo:task.repo,issue:task.issue});
    assert.equal(tool.isError,undefined);
    assert.deepEqual(tool.structuredContent?.workers,snapshot.workers);
    const invalid=await new DevosToolRegistry(root).call("devos_pipeline_status",
      {repo:task.repo,issue:task.issue,passphrase:"do not accept"});
    assert.equal(invalid.isError,true);
    const other=await new DevosToolRegistry(root).call("devos_pipeline_status",
      {repo:"Other/Repo",issue:task.issue});
    assert.equal(other.isError,undefined);
    assert.equal((other.structuredContent?.workers as unknown[]).length,0);
  }finally{await rm(root,{recursive:true,force:true})}
});
test("audit journal is bounded to last 150 records, removes sensitive cause and rejects tampering",async()=>{
  const {root}=await fixture();
  try{
    for(let i=0;i<190;i++)
      await appendTaskAuditEvent(root,task,{
        type:"worker_session_recovered",workerId:"developer",executor:"codex",
        reason:"Error: token=BAD_PRIVATE_SECRET "+i+" https://chatgpt.com/c/private",
      });
    const snapshot=await readPipelineSnapshot(root,task,key);
    assert.equal(snapshot.events.length,150);
    const path=join(root,".devos","logs","timeline",
      "EmporioBreak%2FDevOS-issue-748.jsonl");
    const content=await readFile(path,"utf8");
    assert.ok(content.length<128*1024);
    assert.doesNotMatch(content,/BAD_PRIVATE_SECRET|chatgpt\.com/);
    const corrupt=JSON.parse(content.split("\n")[0]!);
    corrupt.password="oauth-owner-credential";
    await writeFile(path,JSON.stringify(corrupt)+"\n");
    await assert.rejects(readPipelineSnapshot(root,task,key),/unsafe persisted DevOS audit entry/);
  }finally{await rm(root,{recursive:true,force:true})}
});
test("invalid signed worker assignment remains explicitly blocked without raw path disclosure",async()=>{
  const {root}=await fixture();
  try{
    await appendTaskAuditEvent(root,task,{type:"worker_started",
      workerId:"developer",executor:"chatgpt_browser",session:"fresh"});
    const path=join(root,".devos","skills","assignments",
      "EmporioBreak%2FDevOS","748","developer.json");
    const data=JSON.parse(await readFile(path,"utf8"));
    data.manifest.role="attacker";
    await writeFile(path,JSON.stringify(data));
    const result=await readPipelineSnapshot(root,task,key);
    assert.equal(result.workers[0]!.assignment,"invalid");
    assert.match(result.blocker??"",/failed verification/);
    assert.doesNotMatch(JSON.stringify(result),/private|MAC|\.json/);
  }finally{await rm(root,{recursive:true,force:true})}
});
