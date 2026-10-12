import type {Page} from "playwright-core";
import {readExactHistory} from "./chat-worker-observer.js";
import {DynamicAgentGrantRegistry} from "./dynamic-agent-grants.js";
import {isSameChatGptConversation} from "./chatgpt-browser-executor.js";
import type {DynamicAgentPolicy} from "./dynamic-agent-runtime.js";
import type {TaskRef} from "./workflow.js";

const TIME_WINDOW_MS=120_000;
const MAX_CHECKS=12;
const POLL_MS=7_000;
/**
 * COS exact tool-result-origin binding adapted to the existing native
 * Camoufox provider-history reader (not the DOM or assistant chat text).
 *
 * This is invoked ONLY by the trusted task-local browser owner after a real
 * worker turn. V1 grants are not issued, and a stale pre-wake probe cannot
 * regrant a sleeping worker: DynamicAgentGrantRegistry verifies wake receipt,
 * signed v2 policy, process owner, original chat, and epoch before binding.
 *
 * The observer never launches another browser/profile or posts another turn.
 */
export async function observeDynamicWorkerAuthorization(input:{
  page:Page;
  root:string;
  ownerSecret:string;
  policy:DynamicAgentPolicy;
  task:TaskRef;
  agentId:string;
  resourceUri:string;
  expectedConversation:()=>string|undefined;
  expectedUserMessageId:()=>string|undefined;
  exactSubmittedPrompt:string;
  signal:AbortSignal;
}):Promise<boolean>{
  const registry=new DynamicAgentGrantRegistry(input.root,input.ownerSecret);
  const deadline=Date.now()+TIME_WINDOW_MS;
  let checks=0;
  while(!input.signal.aborted&&Date.now()<deadline&&checks<MAX_CHECKS){
    const exact=input.expectedConversation();
    if(exact&&isSameChatGptConversation(exact,input.page.url())){
      checks++;
      const nonce=await readExactHistory(input.page,exact,
        input.expectedUserMessageId(),input.exactSubmittedPrompt,
        input.resourceUri,input.signal);
      if(nonce&&!input.signal.aborted&&
        input.expectedConversation()===exact&&
        isSameChatGptConversation(exact,input.page.url())){
        const accepted=await registry.bindVerifiedNonce({
          task:input.task,agentId:input.agentId,sessionId:exact,
          nonce,policy:input.policy,
        });
        if(accepted)return true;
      }
    }
    await new Promise<void>(resolve=>{
      const timer=setTimeout(done,POLL_MS);
      function done(){clearTimeout(timer);input.signal.removeEventListener("abort",done);resolve();}
      input.signal.addEventListener("abort",done,{once:true});
      if(input.signal.aborted)done();
    });
  }
  return false;
}
