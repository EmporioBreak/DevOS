import type { ExecutorKind, WorkerOutput } from "./workflow.js";

export interface WorkerRequest {
  projectRoot: string;
  prompt: string;
  sessionId?: string;
}

export interface Executor {
  readonly kind: ExecutorKind;
  run(request: WorkerRequest): Promise<WorkerOutput>;
}
