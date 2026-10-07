import type { ExecutorKind, WorkerOutput } from "./workflow.js";

export interface WorkerRequest {
  projectRoot: string;
  prompt: string;
  workerId?: string;
  knownBrowserSessions?: Record<string, string>;
  sessionId?: string;
  enforceProjectScope?: boolean;
  onSession?: (sessionId: string) => void | Promise<void>;
}

export interface Executor {
  readonly kind: ExecutorKind;
  run(request: WorkerRequest): Promise<WorkerOutput>;
}
