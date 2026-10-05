export type ExecutorKind = "codex" | "chatgpt_browser";

export type WorkerStatus =
  | "done"
  | "approved"
  | "changes_requested"
  | "failed";

export interface TaskRef {
  repo: string;
  issue: number;
  pr?: number;
}

export interface WorkerSpec {
  id: string;
  executor: ExecutorKind;
  prompt: string;
  on: Partial<Record<WorkerStatus, string | null>>;
}

export interface Workflow {
  version: 1;
  task: TaskRef;
  start: string;
  workers: WorkerSpec[];
}

export interface DevosResult {
  status: WorkerStatus;
  next?: string;
}

export interface WorkerOutput {
  text: string;
  sessionId?: string;
}
