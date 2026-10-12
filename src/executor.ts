import type { ExecutorKind, WorkerOutput, TaskRef } from "./workflow.js";
import type { WorkerReportTurn } from "./orchestrator.js";
import type { CodexSkillAssignment } from "./codex-skills.js";

export interface WorkerRequest {
  projectRoot: string;
  prompt: string;
  workerId?: string;
  knownBrowserSessions?: Record<string, string>;
  browserTurnId?: string;
  allowToolReportedStatus?: boolean;
  // Serialized across shared-browser IPC; identifies the single authorized
  // MCP report which can terminate browser response waiting for this turn.
  reportTurn?: { task: TaskRef; active: WorkerReportTurn };
  /** Trusted host selects isolated COS-style v2 authorization; never from model text. */
  dynamicAgentV2?: true;
  /** Host-only CoS v2 completion receipt; independent of legacy reportTurn. */
  dynamicTurn?: {task:TaskRef;agentId:string;mode:"bootstrap"|"work";startingGrantEpoch:number};
  sessionId?: string;
  /** Trusted task/worker identity set by Orchestrator, not from prompt. */
  codexSkills?: CodexSkillAssignment;
  enforceProjectScope?: boolean;
  onSession?: (sessionId: string) => void | Promise<void>;
}

export interface Executor {
  readonly kind: ExecutorKind;
  run(request: WorkerRequest): Promise<WorkerOutput>;
}
