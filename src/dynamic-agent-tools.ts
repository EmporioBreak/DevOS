import { DynamicAgentBroker, type DynamicMessageKind } from "./dynamic-agent-runtime.js";

/**
 * CoS src/main/mcp/tools-core.ts registerAgentsTool() adapted to DevOS.
 * This is an isolated V2 protocol handler, not a registered Production MCP.
 * The broker (not the model payload) obtains exact authenticated caller,
 * policy, role and session identity from trusted host boundaries.
 */
export type DynamicAgentToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function fail(message:string):never {throw new Error("DYNAMIC_AGENT_TOOL: "+message);}
function record(input:unknown):Record<string,unknown> {
  if(!input || typeof input!=="object" || Array.isArray(input))return fail("Expected object");
  return input as Record<string,unknown>;
}
function fields(input:Record<string,unknown>, allowed:readonly string[]):void {
  for(const key of Object.keys(input)) if(!allowed.includes(key))fail("Unsupported argument "+key);
}
function string(value:unknown,name:string,min=1,max=4000):string {
  if(typeof value!=="string" || value.trim().length<min || value.length>max)
    return fail("Invalid "+name);
  return value;
}
function identifier(value:unknown,name:string):string {
  const id=string(value,name,1,64);
  if(!ID.test(id))return fail("Invalid "+name);
  return id;
}
function reply(action:string,narrative:string,data:Record<string,unknown>):DynamicAgentToolResponse {
  return { content:[{type:"text",text:narrative}],structuredContent:{action,...data} };
}
export class DynamicAgentToolProtocol {
  constructor(private readonly broker:DynamicAgentBroker,private readonly enabled:boolean) {}
  async call(request:unknown):Promise<DynamicAgentToolResponse> {
    if(!this.enabled)return fail("Dynamic agent runtime is not authorized for this task");
    const input=record(request);
    const action=string(input.action,"action",1,20);
    switch(action){
      case "status": {
        fields(input,["action"]);
        const status=await this.broker.status();
        return reply(action,"Task-scoped agent status and messages.",{
          task:status.task,generation:status.generation,agents:status.agents,
          messages:status.messages,final_review_requested:status.finalReviewRequested,
          ...(status.ownerDecision?{owner_decision:status.ownerDecision}:{})
        });
      }
      case "spawn": {
        fields(input,["action","workers"]);
        if(!Array.isArray(input.workers) || input.workers.length<1 || input.workers.length>8)
          return fail("spawn requires 1..8 workers");
        const workers=input.workers.map((item:unknown)=>{
          const w=record(item);
          fields(w,["id","role","brief","idempotency_key"]);
          return {id:identifier(w.id,"worker id"),role:identifier(w.role,"worker role"),
            brief:string(w.brief,"worker brief",1,4000),
            idempotencyKey:string(w.idempotency_key,"worker idempotency key",8,128)};
        });
        const accepted=await this.broker.requestSpawnBatch(workers);
        return reply(action,`${accepted.length} worker reservation(s) durably accepted. Provider creation is pending host verification.`,{
          workers:accepted.map(w=>({id:w.id,role:w.role,state:w.state}))
        });
      }
      case "message": {
        fields(input,["action","messages"]);
        if(!Array.isArray(input.messages) || input.messages.length<1 || input.messages.length>16)
          return fail("message requires 1..16 messages");
        const messages=input.messages.map((item:unknown)=>{
          const m=record(item);
          fields(m,["to","kind","body","idempotency_key","in_reply_to"]);
          const kind=string(m.kind,"message kind",1,20);
          if(!["work","question","review","evidence","blocker"].includes(kind))
            return fail("Invalid message kind");
          return {to:identifier(m.to,"recipient"),kind:kind as DynamicMessageKind,
            body:string(m.body,"message body",1,16000),
            idempotencyKey:string(m.idempotency_key,"message idempotency key",8,128),
            ...(m.in_reply_to!==undefined?{inReplyTo:string(m.in_reply_to,"reply id",1,128)}:{})};
        });
        const queued=await this.broker.sendBatch(messages);
        return reply(action,`${queued.length} message(s) accepted; delivery or wake is not yet provider-proven.`,{
          queued:queued.map(m=>({id:m.id,to:m.to,state:m.state}))
        });
      }
      case "finish": {
        fields(input,["action","result","idempotency_key","report_to"]);
        const report=await this.broker.finishWork({
          result:string(input.result,"work report",1,16000),
          idempotencyKey:string(input.idempotency_key,"finish idempotency key",8,128),
          ...(input.report_to!==undefined?{reportTo:identifier(input.report_to,"report recipient")}:{})
        });
        return reply(action,"Work unit finished; report queued. This does not approve or close the Issue.",{
          report:{id:report.id,to:report.to,state:report.state}
        });
      }
      case "request_final_review": {
        fields(input,["action"]);
        await this.broker.requestFinalReview();
        return reply(action,"Trusted independent review handoff requested; only Main Agent may accept.",{
          final_review_requested:true
        });
      }
      default:return fail("Unsupported agent action");
    }
  }
}
