import {DynamicAgentBroker,DynamicAgentStore,type DynamicTrustBoundary,
  type VerifiedDynamicCaller} from "./dynamic-agent-runtime.js";
import {DynamicAgentGrantRegistry} from "./dynamic-agent-grants.js";
import {DynamicAgentToolProtocol,type DynamicAgentToolResponse} from "./dynamic-agent-tools.js";
import {readSealedDynamicAgentPolicy,sealedDynamicPolicyVerifier} from "./dynamic-agent-policy.js";
import type {TaskRef} from "./workflow.js";
import {randomUUID} from "node:crypto";

/**
 * Feature-gated v2 MCP surface. Unlike the old v1 worker access grant, this
 * authorization is for agent coordination ONLY, never arbitrary Mac tools.
 * The gateway supplies the real MCP request fingerprint, not tool arguments.
 */
export const DEVOS_DYNAMIC_AGENTS_TOOL={
  name:"devos_agents_v2",
  title:"DevOS dynamic team coordination (v2)",
  description:"Dynamic task-scoped agents: spawn, message, status, finish and review handoff. Requires a separately sealed v2 policy and exact authenticated worker session. Does not authorize Desktop Commander.",
  inputSchema:{type:"object",properties:{
    action:{type:"string",enum:["spawn","message","status","finish","request_final_review"]},
    repo:{type:"string"},issue:{type:"integer",minimum:1},pr:{type:"integer",minimum:1},
    workers:{type:"array",maxItems:8,items:{type:"object"}},
    messages:{type:"array",maxItems:16,items:{type:"object"}},
    result:{type:"string",maxLength:16000},
    idempotency_key:{type:"string",maxLength:128},
    report_to:{type:"string"}
  },required:["action"],additionalProperties:false},
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},
  _meta:{securitySchemes:[{type:"oauth2",scopes:["mcp:tools"]}]},
} as const;

function requireCondition(value:unknown,text:string):asserts value {
  if(!value)throw new Error("DEVOS_AGENTS_V2: "+text);
}
function matchDynamicToolCallTask(a:TaskRef,b:TaskRef):boolean {
  return a.repo===b.repo&&a.issue===b.issue&&(a.pr??null)===(b.pr??null);
}
function validatedTaskSelector(args:Record<string,unknown>):TaskRef {
  const repo=args.repo,issue=args.issue,pr=args.pr;
  requireCondition(typeof repo==="string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    !repo.includes("..") && Number.isSafeInteger(issue) && (issue as number)>0,
    "Owner must select a valid Issue; model values never grant permissions");
  requireCondition(pr===undefined||(Number.isSafeInteger(pr)&&(pr as number)>0),
    "Invalid linked PR selector");
  return {repo,issue:issue as number,...(pr===undefined?{}:{pr:pr as number})};
}
/**
 * Inputs 'ownerApproved' and 'fingerprint' must originate from ChatAccess
 * at the current live MCP request, not from args. The broker repeats checks
 * before publication and never trusts a model's asserted role/session.
 */
export async function callDynamicAgentsMcp(input:{
  root:string;ownerSecret:string;fingerprint:string|undefined;
  ownerApproved:()=>boolean;argumentsValue:unknown;
}):Promise<DynamicAgentToolResponse>{
  requireCondition(typeof input.fingerprint==="string" &&
    /^chat_[a-f0-9]{64}$/.test(input.fingerprint),
    "Exact authenticated MCP request session is missing");
  const fingerprint=input.fingerprint;
  // Capture the real request's entry time here. It must be strictly later
  // than the broker's independent provider wake-acceptance receipt.
  const toolCallStartedAt=Date.now();
  const toolCallId=randomUUID();
  requireCondition(input.argumentsValue && typeof input.argumentsValue==="object" &&
    !Array.isArray(input.argumentsValue),"Expected action object");
  const args=input.argumentsValue as Record<string,unknown>;
  const owner=input.ownerApproved();
  const grants=new DynamicAgentGrantRegistry(input.root,input.ownerSecret);
  const claimedTask=grants.candidateTask(fingerprint);
  requireCondition(!(owner&&claimedTask),"Ambiguous owner and worker session identities");
  let task:TaskRef;
  if(owner){
    task=validatedTaskSelector(args);
  }else{
    requireCondition(!("repo" in args)&&!("issue" in args)&&!("pr" in args),
      "Worker cannot select another Issue");
    requireCondition(claimedTask,"No authenticated v2 worker grant for this session");
    task=claimedTask;
  }
  const policy=await readSealedDynamicAgentPolicy({
    root:input.root,task,ownerSecret:input.ownerSecret
  });
  const verifyPolicy=sealedDynamicPolicyVerifier(input.root,input.ownerSecret);
  const resolveCaller=async():Promise<VerifiedDynamicCaller>=>{
    if(owner){
      requireCondition(input.ownerApproved(),"Owner session was revoked during the call");
      return {task:policy.task,agentId:"main_agent",sessionFingerprint:fingerprint};
    }
    const verified=await grants.resolveCaller(fingerprint,policy);
    requireCondition(verified,"Worker grant revoked, expired, or exact saved session changed");
    return verified;
  };
  const trust:DynamicTrustBoundary={
    resolveCaller,verifyPolicy,
    // These require separate native/provider evidence; no MCP/model payload
    // can issue a lease, attest a spawned chat or mark a review independently.
    verifyNewAgentBinding:async()=>false,
    verifyProviderReceipt:async()=>false,
    verifyTransportLease:async()=>false,
    verifyNoSubmit:async()=>false,
    verifyToolCall:async proof=>{
      if(owner || !matchDynamicToolCallTask(proof.task,policy.task) ||
        proof.recipientId==="" || proof.callId!==toolCallId ||
        proof.startedAt!==toolCallStartedAt || proof.byFinish)return false;
      const active=await grants.resolveCaller(fingerprint,policy);
      return !!active && active.agentId===proof.recipientId;
    },
    verifyIndependentReview:async()=>false,
  };
  const store=new DynamicAgentStore(input.root,policy.task);
  const broker=new DynamicAgentBroker(policy,store,trust);
  if(!owner){
    // CoS noteAgentAlive: a later authenticated MCP request from the SAME
    // verified chat proves wake has actually resumed. A page/DOM observation
    // or the native browser Send receipt alone is insufficient.
    const state=await store.load();
    const agent=state?.agents.find(a=>a.sessionFingerprint===fingerprint);
    if(agent?.status==="waking"){
      const alive=await broker.noteAgentAlive({
        task:policy.task,recipientId:agent.id,callId:toolCallId,
        startedAt:toolCallStartedAt
      });
      requireCondition(alive,
        "Wake was not yet confirmed by provider; retry the tool call, never replay browser Send");
    }
  }
  const filtered={...args};
  delete filtered.repo;delete filtered.issue;delete filtered.pr;
  return new DynamicAgentToolProtocol(broker,true).call(filtered);
}
