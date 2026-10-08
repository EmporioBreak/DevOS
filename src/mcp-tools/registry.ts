import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import type { WorkerReportTurn } from "../orchestrator.js";
import type { TaskRef } from "../workflow.js";
import { dirname, join } from "node:path";
import { JsonStateStore } from "../json-state-store.js";
import type { WorkerStatus } from "../workflow.js";

const REPORT_STATUSES = new Set<WorkerStatus>([
  "done", "approved", "changes_requested", "needs_local_worker", "failed",
]);
export function reportTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function reportPath(root: string, task: TaskRef, turn: WorkerReportTurn): string {
  return join(root, ".devos", "worker-reports",
    `${encodeURIComponent(task.repo)}-issue-${task.issue}`,
    `turn-${turn.turn}-${turn.tokenHash}.json`);
}
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
    description: "Record the status of the currently active worker turn. DevOS checks the report only after the browser turn finishes; the tool alone never triggers routing or owner approval.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub owner/repository" },
        issue: { type: "integer", minimum: 1 },
        worker_id: { type: "string", minLength: 1, maxLength: 100 },
        turn: { type: "integer", minimum: 0, description: "Current completedRuns from devos_task_status" },
        status: { type: "string", enum: [...REPORT_STATUSES] },
        summary: { type: "string", minLength: 1, maxLength: 4096 },
        turn_token: { type: "string", minLength: 64, maxLength: 64, description: "One-turn token provided in the worker's task prompt" },
      },
      required: ["repo", "issue", "worker_id", "turn", "status", "summary", "turn_token"],
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

  async readReport(task: TaskRef, active: WorkerReportTurn): Promise<WorkerStatus | null> {
    let raw: string;
    try { raw = await readFile(reportPath(this.root, task, active), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("Invalid recorded DevOS worker report");
    const report = record as Record<string, unknown>;
    if (report.task && JSON.stringify(report.task) === JSON.stringify({repo: task.repo, issue: task.issue}) &&
        report.worker_id === active.workerId && report.turn === active.turn &&
        report.token_hash === active.tokenHash &&
        typeof report.status === "string" && REPORT_STATUSES.has(report.status as WorkerStatus) &&
        typeof report.summary === "string" && report.summary.length > 0)
      return report.status as WorkerStatus;
    throw new Error("Recorded DevOS worker report identity or content mismatch");
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

      exactKeys(args, ["repo", "issue", "worker_id", "turn", "status", "summary", "turn_token"]);
      const { worker_id: worker, turn, status, summary, turn_token: token } = args;
      if (typeof worker !== "string" || !worker.trim() || worker.length > 100 ||
          typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0 ||
          typeof status !== "string" || !REPORT_STATUSES.has(status as WorkerStatus) ||
          typeof summary !== "string" || !summary.trim() || summary.length > 4096 ||
          typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        throw new Error("Invalid worker report");

      const state = await new JsonStateStore(this.root, task).load();
      const active = state?.activeReport;
      const receivedHash = reportTokenHash(token);
      if (!state || state.currentWorkerId !== worker || state.completedRuns !== turn ||
          state.mainAgentReviewPending || state.completionApproved ||
          active?.workerId !== worker || active.turn !== turn ||
          !timingSafeEqual(Buffer.from(active.tokenHash, "hex"), Buffer.from(receivedHash, "hex")))
        throw new Error("No matching active worker turn");

      // Reports are untrusted evidence, not orchestration authority. Never mutate task state.
      const report = { task, worker_id: worker, turn, status, summary, token_hash: active.tokenHash };
      const path = reportPath(this.root, task, active);
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
