import type {Executor} from "./executor.js";
import type {TaskRef} from "./workflow.js";
import {DynamicAgentBroker,DynamicAgentStore,type DynamicAgentPolicy} from "./dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "./dynamic-agent-grants.js";
import {sealedDynamicPolicyVerifier,readSealedDynamicAgentPolicy} from "./dynamic-agent-policy.js";
import {DynamicBrowserE2EHost} from "./dynamic-agent-browser-e2e-host.js";
import {DynamicDevosExecutorAdapter} from "./dynamic-agent-devos-executor.js";
import {DynamicAgentBootstrapper} from "./dynamic-agent-bootstrap.js";
import {DynamicAgentDispatcher} from "./dynamic-agent-dispatch.js";
import {DynamicWakeDispatcher} from "./dynamic-agent-wake.js";
import {DynamicAgentScheduler} from "./dynamic-agent-scheduler.js";

function matchTask(a:TaskRef,b:TaskRef):boolean {
  return a.repo===b.repo&&a.issue===b.issue&&(a.pr??null)===(b.pr??null);
}
/**
 * First, browser-ONLY live E2E integration: caller injects the ALREADY OWNED
 * DevOS Camoufox executor. No second connector, browser/profile, runner,
 * background daemon, auto-deployment, or migration of any existing v1 task.
 *
 * The constructor performs no I/O. The trusted native host supplies its real
 * approved Main Agent fingerprint, the sealed task policy and existing browser
 * executor. E2E is explicit: initialize -> bootstrap each agent -> queue work
 * -> bounded drain -> inspect authentic reports in state.
 */
export class DynamicFirstBrowserE2E {
  readonly store:DynamicAgentStore;
  readonly broker:DynamicAgentBroker;
  readonly scheduler:DynamicAgentScheduler;
  private readonly bootstrapper:DynamicAgentBootstrapper;
  private readonly wake:DynamicWakeDispatcher;

  constructor(private readonly input:{
    root:string;ownerSecret:string;policy:DynamicAgentPolicy;
    /** From real host authorization, not an MCP/tool/model argument. */
    mainAgentFingerprint:string;
    /** Existing task-owned Camoufox Executor; no new profile may be created. */
    browserExecutor:Executor;
  }){
    if(!/^chat_[a-f0-9]{64}$/.test(input.mainAgentFingerprint) ||
      input.browserExecutor.kind!=="chatgpt_browser")
      throw new Error("First E2E needs real authenticated Main Agent and existing browser executor");
    const {root,policy,ownerSecret}=input;
    this.store=new DynamicAgentStore(root,policy.task);
    const host=new DynamicBrowserE2EHost(root,policy,ownerSecret);
    const grants=new DynamicAgentGrantRegistry(root,ownerSecret);
    this.broker=new DynamicAgentBroker(policy,this.store,{
      resolveCaller:async()=>({
        task:policy.task,agentId:"main_agent",sessionFingerprint:input.mainAgentFingerprint
      }),
      verifyPolicy:sealedDynamicPolicyVerifier(root,ownerSecret),
      verifyNewAgentBinding:async binding=>{
        if(!matchTask(binding.task,policy.task)||!binding.sessionId)return false;
        const state=await this.store.load();
        const agent=state?.agents.find(a=>a.id===binding.id);
        if(!agent||agent.role!==binding.role ||
          agent.sessionId!==binding.sessionId ||
          agent.sessionFingerprint!==binding.sessionFingerprint)return false;
        const verified=await grants.resolveCaller(binding.sessionFingerprint,policy);
        return verified?.agentId===binding.id;
      },
      verifySpawnLease:async lease=>matchTask(lease.task,policy.task),
      verifyTransportLease:async lease=>matchTask(lease.task,policy.task),
      verifyWakeLease:async lease=>matchTask(lease.task,policy.task),
      verifyProviderReceipt:async receipt=>host.verifyMessageReceipt(receipt),
      verifyWakeReceipt:async receipt=>host.verifyWakeReceipt(receipt),
      verifyToolCall:async()=>false,verifyNoSubmit:async()=>false,
    });
    host.setWakeAcceptance(async receipt=>{
      await this.broker.confirmWake({
        task:receipt.task,commandId:receipt.commandId,
        recipientId:receipt.recipientId,conversationId:receipt.conversationId,
        wakeKey:receipt.wakeKey
      },receipt);
    });
    const unsupportedCodex:Executor={kind:"codex",run:async()=>{
      throw new Error("First E2E is browser-only: original signed Codex adapter required");
    }};
    const adapter=new DynamicDevosExecutorAdapter({
      chatgpt_browser:input.browserExecutor,codex:unsupportedCodex
    },host);
    this.bootstrapper=new DynamicAgentBootstrapper(policy,this.store,this.broker,adapter);
    const dispatch=new DynamicAgentDispatcher(this.broker,this.store,adapter);
    this.wake=new DynamicWakeDispatcher(this.broker,this.store,adapter);
    this.scheduler=new DynamicAgentScheduler(this.store,dispatch);
  }
  async initialize():Promise<void>{
    const real=await readSealedDynamicAgentPolicy({
      root:this.input.root,task:this.input.policy.task,ownerSecret:this.input.ownerSecret
    });
    if(JSON.stringify(real)!==JSON.stringify(this.input.policy))
      throw new Error("First E2E exact sealed policy revision mismatch");
    const previous=await this.store.load();
    if(previous){
      // Never reset a partially completed provider journey or signed state.
      await this.broker.status();
    }else{
      await this.broker.initialize();
    }
  }
  async bootstrapBrowserWorker(input:{
    id:string;role:string;brief:string;idempotencyKey:string
  }){
    const role=this.input.policy.roles[input.role];
    if(role?.executor!=="chatgpt_browser")
      throw new Error("First E2E supports only pinned ChatGPT browser workers");
    await this.broker.requestSpawn(input);
    // This is intentionally ONE side-effectful attempt. On unknown outcome,
    // restart must inspect the original session, never call this again.
    return this.bootstrapper.bootstrap({
      task:this.input.policy.task,agentId:input.id,
      idempotencyKey:input.idempotencyKey
    });
  }
  async queueMainWork(to:string,body:string,idempotencyKey:string){
    return this.broker.send({to,kind:"work",body,idempotencyKey});
  }
  /** One bounded, explicit turn of normal and sleeping-worker queues. */
  async drainOnce(maxMessages=8,maxWakes=8){
    const direct=await this.scheduler.drain(maxMessages);
    const waking=await this.scheduler.drainWakes(this.wake,maxWakes);
    return {direct,waking};
  }
  async status(){return this.broker.status();}
}
