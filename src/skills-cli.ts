import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSkillsDiagnostics, previewSkillsUpdate } from "./skill-diagnostics.js";
import type { WorkerSkillContext } from "./skill-policy.js";
import type { SkillDefinition } from "./skills-library.js";
import { parseEnvFile } from "./connector-env.js";

export type SkillsCliCommand =
  | {action:"status"}
  | {action:"issue"; context:WorkerSkillContext}
  | {action:"preview"; skillId:string; candidateFile:string};

const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WORKER=/^[A-Za-z0-9_-]{1,100}$/;
export function parseSkillsCliArgs(args:string[]):SkillsCliCommand {
  if(args.length===1 && args[0]==="status")return {action:"status"};
  if(args[0]==="preview" && args.length===3 &&
      ID.test(args[1]??"") && !!args[2]?.trim())
    return {action:"preview",skillId:args[1]!,candidateFile:args[2]!};
  if(args[0]==="issue" && args.length>=7 &&
      REPO.test(args[1]??"") && /^[1-9][0-9]*$/.test(args[2]??"") &&
      Number.isSafeInteger(Number(args[2])) && WORKER.test(args[3]??"") &&
      ["main_agent","developer","reviewer","qa","auditor"].includes(args[4]??"") &&
      ["planning","execution"].includes(args[5]??"") &&
      (args[6]==="null"||ID.test(args[6]??"")) &&
      args.slice(7).every(x=>ID.test(x)) &&
      new Set(args.slice(7)).size===args.slice(7).length) {
    return {action:"issue",context:{
      repo:args[1]!,issue:Number(args[2]),workerId:args[3]!,role:args[4]!,
      phase:args[5] as "planning"|"execution",
      specKitStage:args[6]==="null"?null:args[6]!,
      optionalCandidates:args.slice(7),
    }};
  }
  throw new Error("Usage: ./devos skills status | ./devos skills issue <owner/repo> <issue> <worker_id> <role> <planning|execution> <specKitStage|null> [optional-skill-id ...] | ./devos skills preview <registered-skill-id> <candidate-json-file>");
}
async function trustedOwnerSecret(root:string):Promise<string|undefined> {
  const fromEnv=process.env.DEVOS_CONNECTOR_OWNER_SECRET?.trim();
  if(fromEnv && Buffer.byteLength(fromEnv)>=32)return fromEnv;
  try {
    const vars=parseEnvFile(await readFile(join(root,".env"),"utf8"));
    const secret=vars.DEVOS_CONNECTOR_OWNER_SECRET?.trim();
    return secret && Buffer.byteLength(secret)>=32?secret:undefined;
  }catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
  }
  return undefined;
}
export async function runSkillsCliCommand(
  command:SkillsCliCommand,root:string,
):Promise<string> {
  if(command.action==="preview") {
    const path=resolve(root,command.candidateFile);
    const data=await readFile(path,"utf8");
    if(Buffer.byteLength(data)>65_536)
      throw new Error("Skill update preview input exceeds 64 KiB");
    const candidate=JSON.parse(data) as SkillDefinition;
    return JSON.stringify(await previewSkillsUpdate(root,command.skillId,candidate),null,2)+"\n";
  }
  const ownerSecret=await trustedOwnerSecret(root);
  const result=await getSkillsDiagnostics(root,{
    ...(ownerSecret?{ownerSecret}:{}),
    ...(command.action==="issue"?{context:command.context}:{}),
  });
  return JSON.stringify(result,null,2)+"\n";
}
