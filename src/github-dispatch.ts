import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./command-runner.js";
import type { Workflow } from "./workflow.js";
import { parseWorkflow } from "./workflow-loader.js";

const MARKER = "<!-- DEVOS_DISPATCH_V1 -->";

export type DispatchMode = "run" | "restart";
export type DispatchStatus = "started" | "completed" | "blocked";

export interface WorkflowDispatch {
  version: 1;
  id: string;
  mode: DispatchMode;
  issue: number;
  workflow: Workflow;
}

export interface IssueSummary {
  number: number;
  body: string;
}

export interface DispatchSource {
  listOpenIssues(repo: string, cwd: string): Promise<IssueSummary[]>;
}

export interface DispatchStore {
  get(key: string): Promise<DispatchStatus | undefined>;
  set(key: string, status: DispatchStatus): Promise<void>;
}

export interface DispatchCycleResult {
  key: string;
  issue: number;
  status: "completed" | "blocked";
  error?: string;
}

export class GhIssueDispatchSource implements DispatchSource {
  constructor(private readonly runner: CommandRunner) {}

  async listOpenIssues(repo: string, cwd: string): Promise<IssueSummary[]> {
    const result = await this.runner.run(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--author",
        "@me",
        "--limit",
        "100",
        "--json",
        "number,body",
      ],
      cwd,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `gh issue list failed with code ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error("gh issue list returned invalid JSON");
    }

    if (!Array.isArray(value)) {
      throw new Error("gh issue list returned invalid issue data");
    }

    return value.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>).number !== "number" ||
        typeof (item as Record<string, unknown>).body !== "string"
      ) {
        throw new Error("gh issue list returned invalid issue data");
      }

      return {
        number: (item as { number: number }).number,
        body: (item as { body: string }).body,
      };
    });
  }
}

export class JsonDispatchStore implements DispatchStore {
  readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, ".devos", "dispatches.json");
  }

  async get(key: string): Promise<DispatchStatus | undefined> {
    const state = await this.load();
    return state[key];
  }

  async set(key: string, status: DispatchStatus): Promise<void> {
    const state = await this.load();
    state[key] = status;
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }

  private async load(): Promise<Record<string, DispatchStatus>> {
    try {
      const raw = await readFile(this.path, "utf8");
      const value: unknown = JSON.parse(raw);

      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid DevOS dispatch state");
      }

      const state: Record<string, DispatchStatus> = {};
      for (const [key, status] of Object.entries(value)) {
        if (
          !key.trim() ||
          (status !== "started" && status !== "completed" && status !== "blocked")
        ) {
          throw new Error("Invalid DevOS dispatch state");
        }
        state[key] = status;
      }
      return state;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw error;
    }
  }
}

export function parseIssueDispatch(
  body: string,
  repo: string,
  issue: number,
): WorkflowDispatch | null {
  const markerIndex = body.indexOf(MARKER);
  if (markerIndex < 0) return null;

  const afterMarker = body.slice(markerIndex + MARKER.length);
  const match = afterMarker.match(/^\s*```json\s*\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(`Issue #${issue} has malformed DevOS dispatch`);
  }

  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error(`Issue #${issue} has invalid DevOS dispatch JSON`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Issue #${issue} has invalid DevOS dispatch`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(
      key =>
        key !== "version" &&
        key !== "id" &&
        key !== "mode" &&
        key !== "workflow",
    ) ||
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !record.id.trim() ||
    record.id.length > 120 ||
    (record.mode !== "run" && record.mode !== "restart")
  ) {
    throw new Error(`Issue #${issue} has invalid DevOS dispatch`);
  }

  const workflow = parseWorkflow(record.workflow);
  if (workflow.task.repo !== repo || workflow.task.issue !== issue) {
    throw new Error(`Issue #${issue} dispatch task does not match its GitHub issue`);
  }

  return {
    version: 1,
    id: record.id,
    mode: record.mode,
    issue,
    workflow,
  };
}

export function dispatchKey(repo: string, dispatch: WorkflowDispatch): string {
  return `${repo}#${dispatch.issue}:${dispatch.id}`;
}

export async function runDispatchCycle(options: {
  repo: string;
  cwd: string;
  source: DispatchSource;
  store: DispatchStore;
  execute: (dispatch: WorkflowDispatch, mode: DispatchMode) => Promise<void>;
}): Promise<DispatchCycleResult | null> {
  const issues = await options.source.listOpenIssues(options.repo, options.cwd);
  issues.sort((a, b) => a.number - b.number);

  for (const issue of issues) {
    const dispatch = parseIssueDispatch(issue.body, options.repo, issue.number);
    if (!dispatch) continue;

    const key = dispatchKey(options.repo, dispatch);
    const status = await options.store.get(key);
    if (status === "completed" || status === "blocked") continue;

    const mode: DispatchMode = status === "started" ? "run" : dispatch.mode;
    if (status !== "started") {
      await options.store.set(key, "started");
    }

    try {
      await options.execute(dispatch, mode);
      await options.store.set(key, "completed");
      return { key, issue: issue.number, status: "completed" };
    } catch (error) {
      await options.store.set(key, "blocked");
      return {
        key,
        issue: issue.number,
        status: "blocked",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
