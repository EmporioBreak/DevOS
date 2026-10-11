import { JsonStateStore } from "./json-state-store.js";
import type { TaskRef } from "./workflow.js";

export interface ActiveBrowserTurn {
  task:TaskRef&{pr?:number};workerId:string;turn:number;tokenHash:string;
  graphSha256:string;workerManifestSha256:string;expiresAt:number;
}

export function assertBrowserCommandMatchesReport(command:{task:TaskRef&{pr?:number};
  workerId:string;turn:number;reportTokenHash:string;expiresAt:number;graphSha256:string;
  workerManifestSha256:string},report:{task:TaskRef&{pr?:number};active:{workerId:string;
    turn:number;tokenHash:string;expiresAt?:number}}):void{
  if(command.task.repo!==report.task.repo||command.task.issue!==report.task.issue||
      command.task.pr!==report.task.pr||command.workerId!==report.active.workerId||
      command.turn!==report.active.turn||command.reportTokenHash!==report.active.tokenHash||
      command.expiresAt!==report.active.expiresAt||!Number.isSafeInteger(command.expiresAt)||
      !/^[a-f0-9]{64}$/.test(command.reportTokenHash)||
      !/^[a-f0-9]{64}$/.test(command.graphSha256)||
      !/^[a-f0-9]{64}$/.test(command.workerManifestSha256))
    throw new Error("Browser command does not match its exact active trusted worker report");
}

/** Compare a signed command with the task's currently persisted one-turn
 * grant immediately before the broker's durable native-Send claim. */
export async function assertCurrentBrowserTurn(root:string,command:ActiveBrowserTurn,
  now=Date.now()):Promise<void>{
  if(!Number.isSafeInteger(command.expiresAt)||command.expiresAt<=now)
    throw new Error("Browser worker grant has expired");
  const state=await new JsonStateStore(root,command.task).load();
  const active=state?.activeReport;
  if(!state||!active||state.task?.repo!==command.task.repo||
      state.task.issue!==command.task.issue||state.task.pr!==(command.task.pr??undefined)||
      state.currentWorkerId!==command.workerId||state.completedRuns!==command.turn||
      active.workerId!==command.workerId||active.turn!==command.turn||
      active.tokenHash!==command.tokenHash||active.expiresAt!==command.expiresAt||
      state.mainAgentReviewPending===true||state.completionApproved===true)
    throw new Error("Browser command no longer matches the active persisted worker grant");
}
