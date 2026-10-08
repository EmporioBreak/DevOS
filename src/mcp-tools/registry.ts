import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JsonStateStore } from "../json-state-store.js";
import type { WorkerStatus } from "../workflow.js";

const REPORT_STATUSES = new Set<WorkerStatus>([
  "done", "approved", "changes_requested", "needs_local_worker", "failed",
]);
type Arguments = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
function input(value: unknown): Arguments {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DevOS tool arguments must be an object");
  return value as Arguments;
}
function taskFrom(args: Arguments) {
  const repo = args.repo;
  const issue = args.issue;
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      repo.includes("..") || typeof issue !== "number" ||
      !Number.isSafeInteger(issue) || issue <= 0)
    throw new Error("Invalid task reference");
  return { repo, issue };
}
function exactKeys(args: Arguments, allowed: string[]) {
  if (Object.keys(args).some(key => !allowed.includes(key)))
    throw new Error("Unsupported DevOS tool argument");
}

export const DEVOS_TOOLS = [
  {
    name: "devos_task_status",
    title: "DevOS task status",
    description: "Read the current local DevOS task progress without exposing browser session URLs.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub owner/repository" },
        issue: { type: "integer", minimum: 1 },
      },
      required: ["repo", "issue"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "devos_worker_report",
    title: "Record DevOS worker report",
    description: "Durably record a report for the currently scheduled worker turn. Acknowledgement does NOT route, approve, or complete the task; orchestration still requires its normal result and owner review.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub owner/repository" },
        issue: { type: "integer", minimum: 1 },
        worker_id: { type: "string", minLength: 1, maxLength: 100 },
        turn: { type: "integer", minimum: 0, description: "Current completedRuns from devos_task_status" },
        status: { type: "string", enum: [...REPORT_STATUSES] },
        summary: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["repo", "issue", "worker_id", "turn", "status", "summary"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
] as const;

export class DevosToolRegistry {
  constructor(private readonly root: string) {}

  has(name: string): boolean {
    return DEVOS_TOOLS.some(tool => tool.name === name);
  }

  list(): Array<Record<string, unknown>> {
    return DEVOS_TOOLS.map(tool => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
      _meta: { securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }] },
    }));
  }

  async call(name: string, argumentsValue: unknown): Promise<ToolResult> {
    if (!this.has(name)) throw new Error("Unknown DevOS tool");
    try {
      const args = input(argumentsValue);
      const task = taskFrom(args);
      if (name === "devos_task_status") {
        exactKeys(args, ["repo", "issue"]);
        const state = await new JsonStateStore(this.root, task).load();
        if (!state) return textResult({ found: false, task });
        return textResult({
          found: true, task,
          worker_id: state.currentWorkerId,
          turn: state.completedRuns,
          review_loops: state.reviewLoops ?? 0,
          main_agent_review_pending: state.mainAgentReviewPending ?? false,
          completion_approved: state.completionApproved ?? false,
        });
      }

      exactKeys(args, ["repo", "issue", "worker_id", "turn", "status", "summary"]);
      const { worker_id: worker, turn, status, summary } = args;
      if (typeof worker !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(worker) ||
          typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0 ||
          typeof status !== "string" || !REPORT_STATUSES.has(status as WorkerStatus) ||
          typeof summary !== "string" || !summary.trim() || summary.length > 4096)
        throw new Error("Invalid worker report");

      const state = await new JsonStateStore(this.root, task).load();
      if (!state || state.currentWorkerId !== worker || state.completedRuns !== turn ||
          state.mainAgentReviewPending || state.completionApproved)
        throw new Error("No matching active worker turn");

      // Reports are untrusted evidence, not orchestration authority. Never mutate task state.
      const report = { task, worker_id: worker, turn, status, summary };
      const path = join(this.root, ".devos", "worker-reports",
        `${encodeURIComponent(task.repo)}-issue-${task.issue}`, `turn-${turn}-${worker}.json`);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(path, JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (JSON.stringify(previous) !== JSON.stringify(report))
          throw new Error("Conflicting report already recorded for this worker turn");
      }
      return textResult({ recorded: true, authoritative: false, task, worker_id: worker, turn });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "DevOS tool failed" }] };
    }
  }
}
