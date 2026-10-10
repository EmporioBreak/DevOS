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
  /** Orchestrator-supplied exact send lease identity, serialized only to the
   * task-owned browser runtime. */
  sendQueueTurn?: { task: TaskRef; workerId: string; turn: number; turnTokenHash: string };
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
