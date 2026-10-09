export type ExecutorKind = "codex" | "chatgpt_browser";

export type WorkerStatus =
  | "done"
  | "approved"
  | "changes_requested"
  | "needs_local_worker"
  | "failed";

export interface TaskRef {
  repo: string;
  issue: number;
  pr?: number;
}

export interface TaskOwner {
  mode: "main_agent";
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
  owner?: TaskOwner;
  /** DevOS 2 requires signed frozen stages and skill manifests. Legacy omitted. */
  skillsMode?: "strict";
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
