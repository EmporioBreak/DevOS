import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureProcessIdentity } from "../src/process-identity.js";
import test from "node:test";
import { ChatWorkerProbeRegistry } from "../src/chat-worker-probe.js";
import { ChatWorkerGrantRegistry, bindProvenWorkerMessage, localWorkerAuthorization } from "../src/chat-worker-grants.js";

const secret = randomBytes(32).toString("hex");
const fpA = "chat_" + "a".repeat(64), fpB = "chat_" + "b".repeat(64);
const task = { repo: "EmporioBreak/DevOS", issue: 99 };
const urlA = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/c/6ac7d917-1390-83ed-95a7-e6309a53e812";
const urlB = "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/c/6ac7d917-1390-83ed-95a7-e6309a53e813";
const uri = "/asdk_app_known/link_known/devos_worker_probe";
const statePath = (root: string) => join(root, ".devos", "state", "EmporioBreak%2FDevOS-issue-99.json");
async function active(root: string, workerId = "developer", turn = 1, sessions = { developer: urlA, reviewer: urlB }) {
  const path = statePath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath=join(root,".devos","locks","EmporioBreak%2FDevOS-issue-99.lock");
  await mkdir(dirname(lockPath),{recursive:true,mode:0o700});
  const identity=await captureProcessIdentity(process.pid);
  assert.ok(identity);
  await writeFile(lockPath,JSON.stringify({repo:task.repo,issue:task.issue,pid:process.pid,
    identity,runId:"test-active-task",startedAt:new Date().toISOString()}),{mode:0o600});
  await writeFile(path, JSON.stringify({
    currentWorkerId: workerId, completedRuns: turn, activeReport: {workerId,turn},
    sessions, mainAgentReviewPending: false, completionApproved: false,
  }));
}
function provider(nonce:string, resource = uri) {
  return {author:{role:"tool",name:"api_tool.call_tool"},status:"finished_successfully",
    metadata:{invoked_resource:{resource_uri:resource}},
    content:{content_type:"code",text:JSON.stringify({result:{structuredContent:{status:"issued",nonce,expires_in_seconds:120}}})}};
}
test("one exact active worker gets passwordless access, unrelated session remains denied",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-worker-grant-"));
  try {
    await active(root);
    const pending=new ChatWorkerProbeRegistry(root,secret), grants=new ChatWorkerGrantRegistry(root,secret);
    assert.equal(grants.isGranted(fpA,5_000_000),false);
    const c=pending.issue(fpA,5_000_000);assert.equal(c.status,"issued");if(c.status!=="issued")return;
    assert.equal(grants.bindVerified(c.nonce,task,"developer",1,urlA,5_000_100),true);
    assert.equal(grants.isGranted(fpA,5_000_101),true);
    assert.deepEqual(grants.activeIdentity(fpA,5_000_101),
      {repo:task.repo,issue:task.issue,workerId:"developer",turn:1});
    assert.equal(grants.activeIdentity(fpB,5_000_101),null);
    const lockPath=join(root,".devos","locks","EmporioBreak%2FDevOS-issue-99.lock");
    const savedLock=await readFile(lockPath,"utf8");
    const forgedLock=JSON.parse(savedLock);
    forgedLock.pid=99999999;
    forgedLock.identity.pid=99999999;
    await writeFile(lockPath,JSON.stringify(forgedLock));
    assert.equal(grants.isGranted(fpA,5_000_101),false,
      "orphaned active task JSON cannot authorize after owner process disappears");
    await writeFile(lockPath,savedLock);
    assert.equal(grants.isGranted(fpA,5_000_101),true);
    assert.equal(grants.isGranted(fpB,5_000_101),false,"other chat on same OAuth client is not authorized");
    assert.equal(grants.bindVerified(c.nonce,task,"developer",1,urlA,5_000_102),false,"nonce replay blocked");
    assert.equal(grants.isGranted(fpA,6_800_100),false,"grant expires independently of task");
    await active(root,"reviewer",2);
    assert.equal(grants.isGranted(fpA,5_000_103),false,"previous turn revoked by live state");
    await active(root,"developer",1,{developer:urlB,reviewer:urlB});
    assert.equal(grants.isGranted(fpA,5_000_103),false,"conversation replacement revokes grant");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("malicious worker assertions, wrong chat/role/turn and copied nonces do not grant",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-worker-adversarial-"));
  try{
    await active(root);
    const pending=new ChatWorkerProbeRegistry(root,secret), grants=new ChatWorkerGrantRegistry(root,secret);
    const a=pending.issue(fpA,5_000_000);assert.equal(a.status,"issued");if(a.status!=="issued")return;
    assert.equal(grants.bindVerified(a.nonce,task,"reviewer",1,urlB,5_000_100),false);
    assert.equal(grants.bindVerified(a.nonce,task,"developer",2,urlA,5_000_100),false);
    assert.equal(grants.bindVerified(a.nonce,task,"developer",1,urlB,5_000_100),false);
    assert.equal(grants.bindVerified(a.nonce,task,"developer",1,urlA+"/",5_000_100),false);
    assert.equal(grants.isGranted(fpA,5_000_100),false);
    // An untrusted ordinary chat cannot authorize by echoing challenge in prompt text.
    assert.equal(grants.bindVerified("0".repeat(64),task,"developer",1,urlA,5_000_100),false);
    assert.equal(grants.bindVerified(a.nonce,task,"developer",1,urlA,5_000_100),true);
    const b=pending.issue(fpB,5_000_101);assert.equal(b.status,"issued");if(b.status!=="issued")return;
    assert.equal(grants.bindVerified(b.nonce,task,"developer",1,urlA,5_000_102),false,"second distinct MCP chat cannot take over same worker");
    assert.equal(grants.isGranted(fpA,5_000_102),true);
    assert.equal(grants.isGranted(fpB,5_000_102),false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("browser provider resource pin and MAC integrity govern grants",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-worker-proof-"));
  try{
    await active(root);
    await writeFile(join(root,".env"),"DEVOS_CONNECTOR_OWNER_SECRET="+secret+"\n",{mode:0o600});
    await mkdir(join(root,".devos","connector"),{recursive:true,mode:0o700});
    await writeFile(join(root,".devos","connector","worker-probe-resource-uri"),uri+"\n",{mode:0o600});
    const pending=new ChatWorkerProbeRegistry(root,secret), grants=new ChatWorkerGrantRegistry(root,secret);
    assert.ok(localWorkerAuthorization(root));
    const a=pending.issue(fpA,5_000_000);assert.equal(a.status,"issued");if(a.status!=="issued")return;
    assert.equal(bindProvenWorkerMessage(root,task,"developer",1,urlA,
      provider(a.nonce,"/unknown/link/devos_worker_probe"),5_000_100),false);
    assert.equal(bindProvenWorkerMessage(root,task,"developer",1,urlA,
      {author:{role:"assistant"},content:{parts:[a.nonce]}},5_000_100),false);
    assert.equal(bindProvenWorkerMessage(root,task,"developer",1,urlA,
      provider(a.nonce),5_000_100),true);
    assert.equal(grants.isGranted(fpA,5_000_101),true);
    const file=join(root,".devos","connector","worker-grants.json");
    assert.equal((await stat(file)).mode & 0o077,0);
    const raw=JSON.parse(await readFile(file,"utf8"));
    raw.entries[0].url=urlB;
    await writeFile(file,JSON.stringify(raw));
    assert.equal(grants.isGranted(fpA,5_000_102),false,"MAC failure denies all");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("two sequential workers stay isolated and local revocation works",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-worker-sequential-"));
  try{
    await active(root);
    const pending=new ChatWorkerProbeRegistry(root,secret), grants=new ChatWorkerGrantRegistry(root,secret);
    const a=pending.issue(fpA,5_000_000);assert.equal(a.status,"issued");if(a.status!=="issued")return;
    assert.equal(grants.bindVerified(a.nonce,task,"developer",1,urlA,5_000_100),true);
    await active(root,"reviewer",2);
    const b=pending.issue(fpB,5_000_200);assert.equal(b.status,"issued");if(b.status!=="issued")return;
    assert.equal(grants.bindVerified(b.nonce,task,"reviewer",2,urlB,5_000_250),true);
    assert.equal(grants.isGranted(fpA,5_000_300),false);
    assert.equal(grants.isGranted(fpB,5_000_300),true);
    grants.revoke(task,"reviewer");
    assert.equal(grants.isGranted(fpB,5_000_300),false);
  }finally{await rm(root,{recursive:true,force:true})}
});
