import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {readFile,realpath,link,writeFile,mkdir,rm} from "node:fs/promises";
import {join,dirname} from "node:path";
import {homedir} from "node:os";
import {parseWorkflow} from "./workflow-loader.js";
import {BrowserSkillDelivery} from "./browser-skill-delivery.js";
import {readWorkerSkillManifest} from "./skill-policy.js";
import type {Workflow} from "./workflow.js";

interface FrozenRunnerWorker{
  workerId:string;executor:"codex"|"chatgpt_browser";
  role:string;stage:string|null;
  manifestSha256:string;
}
interface FrozenRunnerSkillGraph {
  version:1;task:{repo:string;issue:number;pr:number|null};
  graphSha256:string;workers:FrozenRunnerWorker[];
}
interface SignedRunnerGraph {version:2;graph:FrozenRunnerSkillGraph;mac:string}
const H=/^[a-f0-9]{64}$/;
const hash=(obj:unknown)=>createHash("sha256").update(JSON.stringify(obj)).digest("hex");
function sign(graph:FrozenRunnerSkillGraph,secret:string){
  if(Buffer.byteLength(secret)<32)throw new Error("Strong owner secret required to seal Runner");
  const key=createHash("sha256").update("DevOS runner skills graph v1\0").update(secret).digest();
  return createHmac("sha256",key).update(JSON.stringify(graph)).digest("hex");
}
function pathFor(root:string,w:Workflow) {
  return join(root,".devos","skills","graphs",encodeURIComponent(w.task.repo),
    w.task.issue+".json");
}
async function checkedWorkers(root:string,workflow:Workflow,secret:string,
  upstreamRoot:string):Promise<FrozenRunnerWorker[]>{
  const delivery=new BrowserSkillDelivery(root,secret,upstreamRoot);
  const workers:FrozenRunnerWorker[]=[];
  for(const worker of workflow.workers){
    const assigned=await readWorkerSkillManifest(root,workflow.task,worker.id,secret);
    if(assigned.phase!=="execution" ||assigned.role==="main_agent")
      throw new Error("Runner cannot dispatch non-execution/Main Agent skills");
    await delivery.list({repo:workflow.task.repo,issue:workflow.task.issue,
      workerId:worker.id,turn:0});
    workers.push({workerId:worker.id,executor:worker.executor,role:assigned.role,
      stage:assigned.specKitStage,manifestSha256:assigned.sha256});
  }
  return workers;
}
function frozen(workflow:Workflow,workers:FrozenRunnerWorker[]):FrozenRunnerSkillGraph{
  return {version:1,task:{repo:workflow.task.repo,issue:workflow.task.issue,
    pr:workflow.task.pr??null},graphSha256:hash(parseWorkflow(workflow)),workers};
}
/** Main Agent boundary; caller MUST first independently authenticate owner
 * approval of the exact Issue/artifacts and complete worker graph.
 * Not exposed as an MCP tool. Never runs DevOS Runner.
 */
export async function sealRunnerSkillGraph(
  projectRoot:string,workflow:Workflow,ownerSecret:string,
  assertOwnerApproved:()=>Promise<boolean>,
  upstreamRoot=process.env.DEVOS_UPSTREAM_ROOT??join(homedir(),".devos-staging","upstream"),
):Promise<string>{
  const root=await realpath(projectRoot),valid=parseWorkflow(workflow);
  if(valid.skillsMode!=="strict"||valid.owner?.mode!=="main_agent"||
      valid.workers.find(w=>w.id===valid.start)?.executor!=="chatgpt_browser")
    throw new Error("Only pre-approved browser-first Main Agent graphs may be sealed");
  if(!await assertOwnerApproved())
    throw new Error("Missing verified owner approval for frozen Runner graph");
  const review=valid.workers.filter(w=>/review|qa/i.test(w.id));
  const developers=valid.workers.filter(w=>/develop|implement/i.test(w.id));
  if(developers.length && !review.length)
    throw new Error("Strict Runner requires a predeclared independent reviewer");
  for(const worker of valid.workers.filter(w=>w.executor==="codex")){
    if(!valid.workers.some(b=>b.executor==="chatgpt_browser" &&
        b.on.needs_local_worker===worker.id))
      throw new Error("Codex fallback must be predeclared behind browser needs_local_worker");
  }
  const manifest=frozen(valid,await checkedWorkers(root,valid,ownerSecret,upstreamRoot));
  const signed:SignedRunnerGraph={version:2,graph:manifest,mac:sign(manifest,ownerSecret)};
  const file=pathFor(root,valid);
  await mkdir(join(root,".devos","skills","graphs",encodeURIComponent(valid.task.repo)),
    {recursive:true,mode:0o700});
  const safeDir=await realpath(dirname(file));
  if(safeDir!==dirname(file))
    throw new Error("Signed Runner graph directory cannot follow symlinks");
  const bytes=JSON.stringify(signed,null,2)+"\n",tmp=file+"."+randomUUID()+".tmp";
  try{
    await writeFile(tmp,bytes,{flag:"wx",mode:0o600});
    try{await link(tmp,file);}catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      if(await readFile(file,"utf8")!==bytes)
        throw new Error("Runner graph already frozen; no mid-task reassignment");
    }
  }finally{await rm(tmp,{force:true})}
  return manifest.graphSha256;
}
/** Called BEFORE starting browser/runtime and again before every worker turn. */
export async function verifyRunnerSkillGraph(
  root:string,workflow:Workflow,secret:string,
  upstreamRoot=process.env.DEVOS_UPSTREAM_ROOT??join(homedir(),".devos-staging","upstream"),
):Promise<FrozenRunnerSkillGraph>{
  const valid=parseWorkflow(workflow);
  if(valid.skillsMode!=="strict")throw new Error("Strict Runner skill graph expected");
  const origin=await realpath(root);
  const path=pathFor(origin,valid);
  if((await realpath(dirname(path)))!==dirname(path) ||
      (await realpath(path))!==path)
    throw new Error("Signed Runner graph cannot follow symlinked files");
  const parsed=JSON.parse(await readFile(path,"utf8")) as SignedRunnerGraph;
  if(parsed?.version!==2 ||!parsed.graph||!H.test(parsed.mac))
    throw new Error("Runner skill graph signature missing");
  const expected=sign(parsed.graph,secret);
  if(!timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(parsed.mac,"hex")))
    throw new Error("Runner skill graph HMAC mismatch");
  if(parsed.graph.graphSha256!==hash(valid)||
      parsed.graph.task.repo!==valid.task.repo ||
      parsed.graph.task.issue!==valid.task.issue ||
      parsed.graph.task.pr!==(valid.task.pr??null))
    throw new Error("Runner graph does not match originally approved Issue/PR");
  const actual=await checkedWorkers(root,valid,secret,upstreamRoot);
  if(hash(actual)!==hash(parsed.graph.workers))
    throw new Error("Assigned Runner worker skills/stages changed after approval");
  return parsed.graph;
}
