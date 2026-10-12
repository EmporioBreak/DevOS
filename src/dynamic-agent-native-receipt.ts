import type {Page} from "playwright-core";
import {readExactAcceptedUserMessage} from "./chat-worker-observer.js";

/**
 * Host-owned only. Proves native user Send through the original provider
 * history GET, not outgoing POST capture or model-reported completion.
 * Never retries the browser composer; callback is invoked at most once.
 */
export async function observeDynamicNativeSendReceipt(input:{
  page:Page;
  expectedConversation:()=>string|undefined;
  expectedOutgoingMessageId:()=>string|undefined;
  exactPrompt:string;
  signal:AbortSignal;
  onAccepted:(receipt:{sessionId:string;providerMessageId:string})=>Promise<void>|void;
  maxChecks?:number;
  intervalMs?:number;
}):Promise<boolean>{
  const checks=input.maxChecks??5,interval=input.intervalMs??1500;
  if(!Number.isSafeInteger(checks)||checks<1||checks>12||
    !Number.isSafeInteger(interval)||interval<0||interval>10_000)
    throw new Error("Invalid provider receipt observer budget");
  for(let i=0;i<checks&&!input.signal.aborted;i++){
    const chat=input.expectedConversation(),id=input.expectedOutgoingMessageId();
    if(chat&&id&&input.page.url()===chat){
      const accepted=await readExactAcceptedUserMessage(
        input.page,chat,id,input.exactPrompt,input.signal
      );
      if(accepted && !input.signal.aborted &&
        input.expectedConversation()===chat &&
        input.expectedOutgoingMessageId()===id &&
        input.page.url()===chat){
        await input.onAccepted({sessionId:chat,providerMessageId:accepted});
        return true;
      }
    }
    if(i+1<checks)await new Promise<void>(resolve=>{
      const timer=setTimeout(done,interval);
      function done(){clearTimeout(timer);input.signal.removeEventListener("abort",done);resolve();}
      input.signal.addEventListener("abort",done,{once:true});
      if(input.signal.aborted)done();
    });
  }
  return false;
}
