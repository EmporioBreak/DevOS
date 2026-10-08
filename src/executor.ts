import type { ExecutorKind, WorkerOutput, TaskRef } from "./workflow.js";
import type { WorkerReportTurn } from "./orchestrator.js";

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
  sessionId?: string;
  enforceProjectScope?: boolean;
  onSession?: (sessionId: string) => void | Promise<void>;
}

export interface Executor {
  readonly kind: ExecutorKind;
  run(request: WorkerRequest): Promise<WorkerOutput>;
}
