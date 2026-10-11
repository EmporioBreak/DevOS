import type {Workflow} from "./workflow.js";
import type {RunState} from "./orchestrator.js";
import type {OwnerTaskApprovalStore} from "./owner-task-approval.js";
import type {OwnerWakeupLedger,WakeupStatus} from "./owner-wakeup-ledger.js";

export type OwnerHandoffQueueResult=WakeupStatus|"not_due"|"no_binding";

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
  const message=[
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
  return ledger.enqueue(task,round,owner.fingerprint,owner.approvedReference,message);
}
