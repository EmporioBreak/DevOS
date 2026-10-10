import {readFile,realpath,lstat} from "node:fs/promises";
import {join,relative,isAbsolute,sep} from "node:path";

export interface RegressionEvidence {file:string;name:string}
export interface AcceptanceCriterion {
  id:string;criterion:string;
  status:"automated"|"live_pending";
  evidence:RegressionEvidence[];
  liveIssue?:number;
  check?:string;
}
export interface DevosAcceptanceMatrix {
  version:1;epic:121;verificationIssue:149;
  entries:AcceptanceCriterion[];
}
const ID=/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const FILE=/^tests\/[a-z0-9-]+\.test\.ts$/;
const LIVE=new Set([150,151,152,153,154]);
const REQUIRED=[
  "OWNER-SCOPE","SDD-ORIGINAL","CONVERGE-APPEND","BUGFIX-REPRO",
  "ASSESS-NO-CODE","RUNNER-FIXED-GRAPH","RUNNER-LEGACY","SKILLS-POLICY",
  "SKILLS-BROWSER","SKILLS-CODEX","MCP-DEFAULT-DENY","MCP-WORKER-GRANT",
  "MCP-APP-ONE-SHOT","BROWSER-NO-REPLAY","OWNER-REVIEW",
  "TASK-TIMELINE","LIVE-GITHUB-LINKS","LIVE-FEATURE-SDD",
  "LIVE-BUGFIX","LIVE-ASSESS","LIVE-WEB-IOS","LIVE-STAGING-ISOLATION",
  "LIVE-CHAOS","LIVE-DOCS","LIVE-PRODUCTION-GATE","LIVE-OWNER-REPORT",
] as const;
const quotePattern=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function safeText(s:unknown,max:number):s is string {
  return typeof s==="string"&&s.trim().length>0&&s.length<=max&&
    !/[\x00-\x1f]/.test(s);
}
export async function verifyAcceptanceMatrix(
  root:string, raw:unknown,
):Promise<{
  matrix:DevosAcceptanceMatrix;
  automated:number;livePending:number;testRefs:number;
}> {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new Error("Missing acceptance matrix");
  const o=raw as Record<string,unknown>;
  if(o.version!==1||o.epic!==121||o.verificationIssue!==149||
      Object.keys(o).some(k=>!["version","epic","verificationIssue","entries"].includes(k))||
      !Array.isArray(o.entries)||o.entries.length<REQUIRED.length||o.entries.length>90)
    throw new Error("Invalid DevOS 2 acceptance manifest");
  const records=o.entries as AcceptanceCriterion[];
  const seen=new Set<string>();
  const rootReal=await realpath(root);
  let automated=0,livePending=0,testRefs=0;
  for(const item of records){
    if(!item||typeof item!=="object"||Array.isArray(item)||
        Object.keys(item).some(k=>!["id","criterion","status","evidence","liveIssue","check"].includes(k))||
        typeof item.id!=="string"||!ID.test(item.id)||seen.has(item.id)||
        !safeText(item.criterion,250)||!Array.isArray(item.evidence))
      throw new Error("Malformed or duplicate acceptance item");
    seen.add(item.id);
    if(item.status==="live_pending"){
      livePending++;
      if(!LIVE.has(item.liveIssue??0)||!safeText(item.check,500))
        throw new Error("Live acceptance must carry a specific open follow-up Issue");
    }else if(item.status==="automated"){
      automated++;
      if(item.liveIssue!==undefined||item.check!==undefined||
          item.evidence.length===0)
        throw new Error("Automated acceptance cannot claim live result");
    }else throw new Error("Unknown acceptance proof status");
    for(const ref of item.evidence){
      testRefs++;
      if(!ref||typeof ref!=="object"||Array.isArray(ref)||
          Object.keys(ref).some(k=>!["file","name"].includes(k))||
          typeof ref.file!=="string"||!FILE.test(ref.file)||
          !safeText(ref.name,260))
        throw new Error("Unsafe regression evidence reference");
      const path=join(rootReal,ref.file);
      const real=await realpath(path);
      const rel=relative(rootReal,real);
      if(!rel||rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel)||
          !(await lstat(path)).isFile() || real!==path)
        throw new Error("Test evidence escapes pinned staging checkout");
      const source=await readFile(real,"utf8");
      const named=new RegExp(`(?:^|\\n)\\s*test\\(\\s*["']${quotePattern(ref.name)}["']`, "m");
      if(!named.test(source))
        throw new Error("Evidence test is absent or disabled: "+ref.file+" / "+ref.name);
      const disabled=new RegExp(`(?:^|\\n)\\s*test\\.(?:skip|todo|only)\\(\\s*["']${quotePattern(ref.name)}["']`, "m");
      if(disabled.test(source))
        throw new Error("Acceptance test cannot be skipped/todo/only");
    }
  }
  for(const key of REQUIRED)if(!seen.has(key))
    throw new Error("Missing required Epic acceptance route: "+key);
  for(const issue of LIVE)if(!records.some(x=>x.liveIssue===issue))
    throw new Error("No explicit live/release blocker for Issue #"+issue);
  return {matrix:raw as DevosAcceptanceMatrix,automated,livePending,testRefs};
}
