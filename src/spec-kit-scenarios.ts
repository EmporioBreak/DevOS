import {createHash} from "node:crypto";
import {readFile,realpath,stat} from "node:fs/promises";
import {resolve,relative,isAbsolute,sep,join} from "node:path";
import {homedir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {validateSpecKitContract,type SpecKitArtifactContract} from "./spec-kit-contract.js";

const run=promisify(execFile);
const sha=(data:Buffer|string)=>createHash("sha256").update(data).digest("hex");
const COMMIT=/^[0-9a-f]{40}$/;
const SOURCE=/^[A-Za-z0-9_.:-]{6,120}$/;
export type OriginalScenario="bug"|"assess";
export interface OriginalScenarioStageEvidence{
  stage:string;sourceRef:string;workerId:string;
  commit:string;artifact:string;
}
export type OriginalScenarioVerifier=(evidence:OriginalScenarioStageEvidence,
  expected:{stage:string;issue:number;artifact:string;sourceHash:string})=>Promise<boolean>;
/** Pin exactly the official spec-kit extension command, with no rewrites. */
export async function verifyOriginalScenarioCommand(
  root:string,scenario:OriginalScenario,command:string,
  upstreamRoot=process.env.DEVOS_UPSTREAM_ROOT??join(homedir(),".devos-staging","upstream"),
):Promise<{relativePath:string;sha256:string;content:string}> {
  const allowed=scenario==="bug"?["assess","fix","test"]:
    ["intake","research","shape","define","decide"];
  if(!allowed.includes(command))throw new Error("Unknown original Spec Kit extension stage");
  const manifest=JSON.parse(await readFile(join(root,"config","devos-upstreams.lock.json"),"utf8")) as {
    version:number;sources:Array<{id:string;commit:string;keyFiles:Record<string,string>}>;
  };
  const official=manifest.sources.find(s=>s.id==="spec-kit");
  if(manifest.version!==1||!official||!COMMIT.test(official.commit))
    throw new Error("Missing pinned original Spec Kit source");
  const relativePath="extensions/"+scenario+"/commands/speckit."+
    scenario+"."+command+".md";
  const expected=official.keyFiles[relativePath];
  if(!expected||!/^[a-f0-9]{64}$/.test(expected))
    throw new Error("Original Spec Kit extension command is not pinned");
  const upstream=await realpath(join(upstreamRoot,"spec-kit"));
  const file=await realpath(join(upstream,relativePath));
  const diff=relative(upstream,file);
  if(!diff||diff===".."||diff.startsWith(".."+sep)||isAbsolute(diff))
    throw new Error("Pinned extension escapes upstream root");
  const bytes=await readFile(file);
  if(sha(bytes)!==expected)
    throw new Error("Original Spec Kit extension command integrity mismatch");
  return {relativePath,sha256:expected,content:bytes.toString("utf8")};
}
async function verifiedFile(root:string,path:string,commit:string):Promise<string> {
  if(!COMMIT.test(commit) || !/^\.(?:specify)\/[A-Za-z0-9_./-]+$/.test(path) ||
      path.split("/").some(s=>s===".."||s==="."))
    throw new Error("Invalid original scenario artifact reference");
  const rr=await realpath(root),actual=await realpath(resolve(rr,path));
  const diff=relative(rr,actual);
  if(!diff||diff===".."||diff.startsWith(".."+sep)||isAbsolute(diff) ||
      !(await stat(actual)).isFile())
    throw new Error("Original scenario artifact escapes worktree");
  let committed:Buffer;
  try {
    committed=(await run("git",["-C",rr,"show",commit+":"+path],
      {encoding:"buffer",timeout:15000,maxBuffer:8*1024*1024})).stdout;
  }catch {throw new Error("Original scenario artifact not committed at pinned Git SHA");}
  const actualBytes=await readFile(actual);
  if(!actualBytes.equals(committed))throw new Error("Original scenario artifact drift");
  return actualBytes.toString("utf8");
}
export async function verifyScenarioStage(
  root:string,contract:SpecKitArtifactContract,scenario:OriginalScenario,
  stage:string,evidence:OriginalScenarioStageEvidence,verify:OriginalScenarioVerifier,
  upstreamRoot?:string,
):Promise<string> {
  const original=validateSpecKitContract(contract);
  const expectedScenario=scenario==="bug"?"bugfix":"assess";
  if(original.scenario!==expectedScenario ||
      !original.artifacts[stage] || !evidence ||
      evidence.stage!==stage || evidence.artifact!==original.artifacts[stage] ||
      !SOURCE.test(evidence.sourceRef) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(evidence.workerId))
    throw new Error("Stage evidence does not match original scenario Issue");
  const official=await verifyOriginalScenarioCommand(root,scenario,
    scenario==="assess" && stage==="concept"?"shape":
    scenario==="assess" && stage==="problem"?"define":
    scenario==="assess" && stage==="decision"?"decide":
    scenario==="bug" && stage==="assessment"?"assess":
    scenario==="bug" && stage==="fix"?"fix":
    scenario==="bug" && stage==="test"?"test":stage,upstreamRoot);
  const content=await verifiedFile(root,evidence.artifact,evidence.commit);
  if(!await verify(evidence,{stage,issue:original.task.issue,
    artifact:evidence.artifact,sourceHash:official.sha256}))
    throw new Error("Original scenario stage result not independently trusted");
  return content;
}
