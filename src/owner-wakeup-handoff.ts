import type {Workflow} from "./workflow.js";
import type {RunState} from "./orchestrator.js";
import type {OwnerTaskApprovalStore} from "./owner-task-approval.js";
import type {OwnerWakeupLedger,WakeupStatus} from "./owner-wakeup-ledger.js";
import {canonicalPrivateChatUrl} from "./chat-access.js";
import type {TaskRef} from "./workflow.js";

export type OwnerHandoffQueueResult=WakeupStatus|"not_due"|"no_binding";
export interface OwnerWakeupDeliveryRequest {
  projectRoot:string;
  task:TaskRef&{pr:number};
  reviewRound:number;
  ownerFingerprint:string;
  approvedReference:string;
  ownerKind:"private"|"share_label";
  message:string;
}

/** A public share snapshot is only an approval label, never a writable chat.
 * Do not infer its private source conversation from page contents or redirects. */
export function writableOwnerWakeupUrl(target:{approvedReference:string;kind:"private"|"share_label"}):string{
  if(target.kind!=="private")
    throw new Error("Owner wake-up requires a separately verified private /c/ binding");
  const url=canonicalPrivateChatUrl(target.approvedReference);
  if(url!==target.approvedReference)
    throw new Error("Owner wake-up private conversation binding is not canonical");
  return url;
}

export function buildOwnerHandoffMessage(task:{repo:string;issue:number;pr?:number},round:number):string{
  if(!Number.isSafeInteger(task.issue)||task.issue<1||!Number.isSafeInteger(task.pr)||!task.pr||
     !Number.isSafeInteger(round)||round<0||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repo))
    throw new Error("Invalid exact owner handoff task or review round");
  return [
    "DevOS — автоматическое уведомление о готовности задачи к проверке Main Agent.",
    "Это обычное уведомление, НЕ системное сообщение, НЕ утверждение владельца",
    "и НЕ доказательство успешных тестов или право автоматически сливать PR.",
    `GitHub Issue: https://github.com/${task.repo}/issues/${task.issue}`,
    `GitHub PR: https://github.com/${task.repo}/pull/${task.pr}`,
    `Раунд финального ревью: ${round}.`,
    "Проверь исходную постановку, текущий diff, подписанные отчёты и реальные тесты.",
    "Решение approved или changes_requested принимает только действующий Main Agent",
    "через доверенный канал DevOS; при ошибке исправления идут в тот же Issue/PR.",
  ].join("\n");
}

/** Prepare a normal user-role notification only *after* Orchestrator has
 * persisted final_review_required. This does not click, start Camoufox,
 * assume chat idle, or claim that a notification was ever delivered.
 *
 * An owner authorization alone is not consent to approve/merge an Issue.
 * The task/PR identity comes only from an already-validated sealed graph.
 */
export async function enqueueOwnerHandoff(input:{
  workflow:Workflow;state:RunState;store:OwnerTaskApprovalStore;ledger:OwnerWakeupLedger;
}):Promise<OwnerHandoffQueueResult>{
  const {workflow,state,store,ledger}=input;
  const task=workflow.task;
  const round=state.reviewLoops;
  if(workflow.owner?.mode!=="main_agent"||
     !Number.isSafeInteger(task.issue)||task.issue<1||
     !Number.isSafeInteger(task.pr)||!task.pr||
     state.mainAgentReviewPending!==true||state.completionApproved===true||
     state.task?.repo!==task.repo||state.task.issue!==task.issue||
     state.task.pr!==task.pr||
     !Number.isSafeInteger(state.completedRuns)||state.completedRuns<1||
     typeof round!=="number"||!Number.isSafeInteger(round)||round<0||
     Object.keys(state.sessions??{}).length===0)
    return "not_due";
  const owner=store.resolveOwnerChatForTask({repo:task.repo,issue:task.issue,pr:task.pr});
  if(!owner)return "no_binding";

  // Stable bytes are necessary for idempotent re-entry into an already
  // persisted handoff, including after Runner exits.
  const message=buildOwnerHandoffMessage(task,round);
  return ledger.enqueue(task,round,owner.fingerprint,owner.approvedReference,message);
}
