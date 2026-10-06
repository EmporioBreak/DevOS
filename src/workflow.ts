export type ExecutorKind = "codex" | "chatgpt_browser";

export type WorkerStatus =
  | "done"
  | "approved"
  | "changes_requested"
  | "needs_host"
  | "failed";

export interface TaskRef {
  repo: string;
  issue: number;
  pr?: number;
}

export type TaskOwner =
  | {
      mode: "chatgpt_conversation";
      conversationUrl: string;
    }
  | {
      mode: "parent_process";
    };

export interface WorkerSpec {
  id: string;
  executor: ExecutorKind;
  prompt: string;
  on: Partial<Record<WorkerStatus, string | null>>;
}

export interface Workflow {
  version: 1;
  task: TaskRef;
  owner?: TaskOwner;
  start: string;
  workers: WorkerSpec[];
}

export interface DevosResult {
  status: WorkerStatus;
}

export interface WorkerOutput {
  text: string;
  sessionId?: string;
}
