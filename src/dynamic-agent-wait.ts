import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {canonicalPrivateChatUrl} from "./chat-access.js";
import {parseEnvFile} from "./connector-env.js";
import {DynamicAgentStore} from "./dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "./dynamic-agent-grants.js";
import {readSealedDynamicAgentPolicy} from "./dynamic-agent-policy.js";
import type {TaskRef} from "./workflow.js";

/** Trusted, immutable per-worker v2 turn assignment. Never supplied by a model. */
export interface DynamicBrowserTurn {
  task:TaskRef;
  agentId:string;
  mode:"bootstrap"|"work";
  /** An earlier work-unit finish must not satisfy a later browser send. */
  startingGrantEpoch:number;
}
async function localSecret(root:string):Promise<string|null>{
  let env:Record<string,string>={};
  try{env=parseEnvFile(await readFile(join(root,".env"),"utf8"));}catch{}
  const secret=process.env.DEVOS_CONNECTOR_OWNER_SECRET?.trim() ||
    env.DEVOS_CONNECTOR_OWNER_SECRET?.trim() || "";
  return Buffer.byteLength(secret)>=32 ? secret : null;
}
/**
 * CoS worker lifecycle mapped to DevOS's real v2 state:
 * - fresh chat: end the probe-only bootstrap turn only after the exact v2
 *   grant has been authenticated and persisted for that saved conversation;
 * - work: end only when a later MCP finishWork increments that worker's
 *   durable grant epoch, avoiding a stale previous finish in the same chat.
 *
 * No polling of ChatGPT DOM / assistant text, no v1 worker_report, no replay.
 * An abort or timeout leaves the browser Send in its existing uncertain fence.
 */
export async function waitForDynamicBrowserTurn(input:{
  root:string;turn:DynamicBrowserTurn;
  expectedConversation:()=>string|undefined;
  signal:AbortSignal;maxWaitMs:number;
  /** Only for host-owned tests; never sourced from a WorkerRequest/MCP args. */
  trustedSecret?:string;
  pollMs?:number;
}):Promise<void>{
  const {root,turn,signal}=input;
  if(process.env.DEVOS_DYNAMIC_AGENTS_V2!=="enabled")
    throw new Error("Dynamic browser completion requires enabled host feature gate");
  if(!Number.isSafeInteger(input.maxWaitMs)||input.maxWaitMs<1||input.maxWaitMs>600_000||
    !Number.isSafeInteger(turn.startingGrantEpoch)||turn.startingGrantEpoch<0||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(turn.agentId))
    throw new Error("Invalid host-owned dynamic worker turn");
  const secret=input.trustedSecret ?? await localSecret(root);
  if(!secret)throw new Error("No trusted local v2 owner secret");
  const policy=await readSealedDynamicAgentPolicy({root,task:turn.task,ownerSecret:secret});
  const registry=new DynamicAgentGrantRegistry(root,secret);
  const store=new DynamicAgentStore(root,turn.task);
  const deadline=Date.now()+input.maxWaitMs;
  const pollMs=Math.max(20,Math.min(input.pollMs??350,2000));
  while(!signal.aborted && Date.now()<deadline){
    const chat=input.expectedConversation();
    let exact:string|null=null;
    try{if(chat && canonicalPrivateChatUrl(chat)===chat)exact=chat;}
    catch{}
    if(exact){
      const state=await store.load().catch(()=>null);
      const agent=state?.agents.find(a=>a.id===turn.agentId);
      if(agent?.executor==="chatgpt_browser" &&
        agent.sessionId===exact &&
        state?.policyHash && state?.ownerDecision!=="approved"){
        if(turn.mode==="bootstrap"){
          if(agent.grantEpoch===undefined || agent.grantEpoch===turn.startingGrantEpoch){
            const verified=await registry.resolveCaller(agent.sessionFingerprint,policy);
            if(verified?.agentId===agent.id && verified.sessionFingerprint===agent.sessionFingerprint)
              return;
          }
        }else if((agent.grantEpoch??0)>turn.startingGrantEpoch &&
          (agent.status==="sleeping"||agent.status==="terminal") &&
          !!agent.lastFinishKey && !!agent.lastResult){
          return;
        }
      }
    }
    await new Promise<void>(resolve=>{
      const timer=setTimeout(done,Math.min(pollMs,Math.max(1,deadline-Date.now())));
      function done(){clearTimeout(timer);signal.removeEventListener("abort",done);resolve();}
      signal.addEventListener("abort",done,{once:true});
      if(signal.aborted)done();
    });
  }
  throw new Error(signal.aborted ?
    "Dynamic worker completion aborted; do not replay an ambiguous turn" :
    "Dynamic worker completion not proven before deadline; do not replay the turn");
}
