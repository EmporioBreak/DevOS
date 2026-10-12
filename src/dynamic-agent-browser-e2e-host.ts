import {canonicalPrivateChatUrl} from "./chat-access.js";
import {DynamicAgentStore,type DynamicAgentPolicy,type DynamicDeliveryReceipt,
  type DynamicWakeReceipt} from "./dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "./dynamic-agent-grants.js";
import {readSealedDynamicAgentPolicy} from "./dynamic-agent-policy.js";
import type {DynamicTrustedExecutorHost} from "./dynamic-agent-devos-executor.js";
import type {WorkerRequest} from "./executor.js";
import type {TaskRef} from "./workflow.js";

function sameTask(a:TaskRef,b:TaskRef):boolean {
  return a.repo===b.repo && a.issue===b.issue && (a.pr??null)===(b.pr??null);
}
function invariant(value:unknown,msg:string):asserts value {
  if(!value)throw new Error("DYNAMIC_BROWSER_E2E_HOST: "+msg);
}
interface SendEvidence {
  task:TaskRef;commandId:string;agentId:string;sessionId:string;
  providerMessageId:string;
}
/**
 * Browser-only first-E2E host bridge. Receives the EXISTING native DevOS
 * ChatGptBrowserExecutor from the owning runtime; it never creates Camoufox
 * processes/profiles, registers a second connector, or retries browser Sends.
 *
 * Codex remains deliberately denied here. A real Codex host with signed
 * pinned assignments must be connected separately, not faked for E2E.
 */
export class DynamicBrowserE2EHost implements DynamicTrustedExecutorHost {
  private readonly accepted=new Map<string,SendEvidence>();
  private onWakeAccepted?: (receipt:DynamicWakeReceipt)=>Promise<void>;
  /** Native host-only callback: persist wake ACK as soon as provider GET proves it. */
  setWakeAcceptance(handler:(receipt:DynamicWakeReceipt)=>Promise<void>):void{
    this.onWakeAccepted=handler;
  }
  constructor(
    private readonly root:string,
    private readonly policy:DynamicAgentPolicy,
    private readonly ownerSecret:string
  ){}
  private async state(){
    invariant(await readSealedDynamicAgentPolicy({
      root:this.root,task:this.policy.task,ownerSecret:this.ownerSecret
    }).then(p=>JSON.stringify(p)===JSON.stringify(this.policy)).catch(()=>false),
    "Only the exact host-sealed role/skill/Issue/PR policy can run");
    const state=await new DynamicAgentStore(this.root,this.policy.task).load();
    invariant(state&&sameTask(state.task,this.policy.task)&&
      state.ownerDecision!=="approved","Task is uninitialized or already accepted");
    return state;
  }
  private base(agentId:string,prompt:string,mode:"bootstrap"|"work",
    startingGrantEpoch:number,sessionId?:string):WorkerRequest{
    invariant(process.env.DEVOS_DYNAMIC_AGENTS_V2==="enabled",
      "Native host must explicitly enable v2 coordination");
    return {
      projectRoot:this.root,prompt,workerId:agentId,
      ...(sessionId?{sessionId}:{}),
      enforceProjectScope:true,dynamicAgentV2:true,
      dynamicTurn:{task:this.policy.task,agentId,mode,startingGrantEpoch}
    };
  }
  async prepareBootstrap(input:Parameters<DynamicTrustedExecutorHost["prepareBootstrap"]>[0])
    :Promise<WorkerRequest>{
    invariant(sameTask(input.task,this.policy.task) && input.executor==="chatgpt_browser",
      "First browser E2E cannot impersonate Codex or cross task");
    const state=await this.state();
    const pending=state.pendingSpawns?.find(p=>p.id===input.agentId &&
      p.state==="bootstrap_uncertain"&&p.role===input.role&&p.brief===input.brief);
    const rule=this.policy.roles[input.role];
    invariant(pending && rule?.executor==="chatgpt_browser" &&
      rule.manifestSha256===input.manifestSha256 &&
      !state.agents.some(a=>a.id===input.agentId),
      "Bootstrap needs its original durable claim and pinned role/skills");
    // Bootstrap is *probe only*. Subsequent task messages are sent on the
    // SAME saved conversation after the observer finishes authenticated bind.
    const prompt=[
      "DevOS dynamic worker identity handshake.",
      `Task: ${input.task.repo} Issue #${input.task.issue} PR #${input.task.pr??"none"}.`,
      `Worker ID: ${input.agentId}. Role: ${input.role}.`,
      "Invoke the connected DevOS devos_worker_probe tool exactly once with no arguments.",
      "Do not perform work, create a second chat, request owner password,",
      "call any Desktop Commander tool, or infer authorization from this text.",
      "Wait for the host to send the task work in this same conversation."
    ].join("\n");
    return this.base(input.agentId,prompt,"bootstrap",0);
  }
  private record(input:SendEvidence):void{
    invariant(sameTask(input.task,this.policy.task)&&
      canonicalPrivateChatUrl(input.sessionId)===input.sessionId &&
      /^[A-Za-z0-9_-]{1,200}$/.test(input.providerMessageId),
      "Native provider receipt has wrong session or ID");
    const existing=this.accepted.get(input.commandId);
    invariant(!existing || existing.providerMessageId===input.providerMessageId &&
      existing.sessionId===input.sessionId && existing.agentId===input.agentId,
      "Conflicting provider user messages for one broker command");
    if(!existing){
      invariant(this.accepted.size<128,"Evidence ledger budget exceeded");
      this.accepted.set(input.commandId,input);
    }
  }
  private prepareWork(agentId:string,sessionId:string,commandId:string,
    prompt:string,epoch:number):WorkerRequest{
    const request=this.base(agentId,prompt,"work",epoch,sessionId);
    request.onAcceptedUserMessage=receipt=>{
      invariant(receipt.sessionId===sessionId,
        "Native provider receipt changed the saved conversation");
      this.record({task:this.policy.task,commandId,agentId,sessionId,
        providerMessageId:receipt.providerMessageId});
    };
    return request;
  }
  async prepareMessage(input:Parameters<DynamicTrustedExecutorHost["prepareMessage"]>[0])
    :Promise<WorkerRequest>{
    invariant(sameTask(input.task,this.policy.task) &&
      input.recipient.executor==="chatgpt_browser" &&
      !!input.recipient.sessionId,"Only original task browser worker is routable");
    const state=await this.state();
    const agent=state.agents.find(a=>a.id===input.recipient.id);
    const message=state.messages.find(m=>m.id===input.message.id &&
      m.to===input.recipient.id && m.state==="dispatch_uncertain");
    invariant(agent?.sessionId===input.recipient.sessionId &&
      agent.executor==="chatgpt_browser" && message &&
      message.from===input.message.from && message.body===input.message.body,
      "Message has no exact durable broker claim or saved recipient chat");
    const prompt=[
      `DevOS task ${this.policy.task.repo} Issue #${this.policy.task.issue}.`,
      `You are ${agent.id}; work request from ${message.from} (${message.kind}).`,
      `Message ID: ${message.id}. This instruction is part of the active task scope.`,
      "--- BEGIN TEAMMATE MESSAGE ---",message.body,"--- END TEAMMATE MESSAGE ---",
      "Use devos_agents_v2 to message teammates or finish the work unit.",
      "Do not switch chats, grant new privileges or repeat the user-message Send."
    ].join("\n");
    return this.prepareWork(agent.id,agent.sessionId!,message.id,prompt,
      agent.grantEpoch??0);
  }
  async prepareWake(input:Parameters<DynamicTrustedExecutorHost["prepareWake"]>[0])
    :Promise<WorkerRequest>{
    invariant(sameTask(input.task,this.policy.task) &&
      input.executor==="chatgpt_browser",
      "Only original ChatGPT worker can use browser wake");
    const state=await this.state();
    const agent=state.agents.find(a=>a.id===input.recipientId);
    const command=state.wakeCommands?.find(c=>c.id===input.commandId &&
      c.wakeKey===input.wakeKey && c.conversationId===input.conversationId &&
      c.recipientId===input.recipientId && c.state==="claimed");
    invariant(agent?.status==="waking" && agent.executor==="chatgpt_browser" &&
      agent.sessionId===input.conversationId && command &&
      command.messageIds.length===input.messages.length &&
      command.messageIds.every((id,index)=>id===input.messages[index]?.id),
      "Wake command was not claimed for the exact saved chat/message batch");
    const prompt=[
      `DevOS wake in original conversation for ${input.recipientId}.`,
      `Task: ${input.task.repo} Issue #${input.task.issue}.`,
      `Wake command: ${command.id}; do not replay any prior work.`,
      ...input.messages.flatMap(m=>[
        `--- MESSAGE ${m.id} from ${m.from} (${m.kind}) ---`,m.body
      ]),
      "Use devos_agents_v2 for direct teammate messages and finish.",
      "Do not open another conversation or request owner credentials."
    ].join("\n");
    const request=this.prepareWork(agent.id,agent.sessionId!,command.id,prompt,
      agent.grantEpoch??0);
    const prior=request.onAcceptedUserMessage;
    request.onAcceptedUserMessage=async receipt=>{
      await prior?.(receipt);
      // The browser turn may still be running. Confirming AFTER Executor.run
      // returns would deadlock noteAgentAlive/finishWork in the same turn.
      await this.onWakeAccepted?.({
        task:this.policy.task,commandId:command.id,recipientId:agent.id,
        conversationId:agent.sessionId!,wakeKey:command.wakeKey,
        providerMessageId:receipt.providerMessageId
      });
    };
    return request;
  }
  async verifiedBootstrap(input:Parameters<DynamicTrustedExecutorHost["verifiedBootstrap"]>[0])
    :Promise<string|null>{
    if(!sameTask(input.task,this.policy.task) ||
      input.executor!=="chatgpt_browser"||input.output.sessionId!==input.sessionId)return null;
    const state=await this.state().catch(()=>null);
    const agent=state?.agents.find(a=>a.id===input.agentId);
    if(!agent||agent.role!==input.role || agent.sessionId!==input.sessionId ||
      agent.manifestSha256!==input.manifestSha256)return null;
    const granted=await new DynamicAgentGrantRegistry(this.root,this.ownerSecret)
      .resolveCaller(agent.sessionFingerprint,this.policy);
    return granted?.agentId===input.agentId ? granted.sessionFingerprint : null;
  }
  async verifiedProviderMessage(input:Parameters<DynamicTrustedExecutorHost["verifiedProviderMessage"]>[0])
    :Promise<string|null>{
    if(!sameTask(input.task,this.policy.task))return null;
    const value=this.accepted.get(input.commandId);
    return value && value.agentId===input.workerId &&
      value.sessionId===input.sessionId &&
      input.output.sessionId===input.sessionId
      ? value.providerMessageId:null;
  }
  /** For DynamicTrustBoundary.verifyProviderReceipt after normal Send. */
  verifyMessageReceipt(receipt:DynamicDeliveryReceipt):boolean{
    const value=this.accepted.get(receipt.messageId);
    return !!value&&sameTask(value.task,receipt.task)&&
      value.providerMessageId===receipt.providerMessageId;
  }
  /** For DynamicTrustBoundary.verifyWakeReceipt after same-chat revival. */
  verifyWakeReceipt(receipt:DynamicWakeReceipt):boolean{
    const value=this.accepted.get(receipt.commandId);
    return !!value&&sameTask(value.task,receipt.task)&&
      value.agentId===receipt.recipientId&&
      value.sessionId===receipt.conversationId&&
      value.providerMessageId===receipt.providerMessageId;
  }
}
