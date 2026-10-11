import type { ExecutorKind, WorkerOutput, TaskRef } from "./workflow.js";
import type { WorkerReportTurn } from "./orchestrator.js";
import type { CodexSkillAssignment } from "./codex-skills.js";

export interface WorkerRequest {
  projectRoot: string;
  prompt: string;
  workerId?: string;
  knownBrowserSessions?: Record<string, string>;
  browserTurnId?: string;
  /** Trusted identity assigned by Orchestrator for the one native browser Send. */
  browserCommand?: { task: TaskRef; workerId: string; turn: number; commandId: string };
  allowToolReportedStatus?: boolean;
  // Serialized across shared-browser IPC; identifies the single authorized
  // MCP report which can terminate browser response waiting for this turn.
  reportTurn?: { task: TaskRef; active: WorkerReportTurn };
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
