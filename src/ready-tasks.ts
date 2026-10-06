import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { validateChatGptUrl } from "./browser-config.js";
import { isTaskCompleted } from "./completed-tasks.js";
import type { CommandRunner } from "./command-runner.js";
import type { Workflow } from "./workflow.js";
import { parseWorkflow } from "./workflow-loader.js";

const TASK_MARKER = "<!-- DEVOS_TASK_V1 -->";

export interface ProjectConfig {
  version: 1;
  repo: string;
  chatgptProjectUrl?: string;
}

export interface ReadyTask {
  issue: number;
  title: string;
  mode: "run" | "restart";
  workflow: Workflow;
}

export async function loadOrCreateProjectConfig(
  projectRoot: string,
  runner: CommandRunner,
): Promise<ProjectConfig> {
  const path = join(projectRoot, ".devos", "config.json");

  try {
    const raw = await readFile(path, "utf8");
    const value: unknown = JSON.parse(raw);
    return parseProjectConfig(value);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const remote = await runner.run(
    "git",
    ["config", "--get", "remote.origin.url"],
    projectRoot,
  );
  if (remote.exitCode !== 0) {
    throw new Error(
      "DevOS could not determine the project repository. Configure git remote origin first.",
    );
  }

  const repo = parseGitHubRepo(remote.stdout.trim());
  const config: ProjectConfig = { version: 1, repo };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return config;
}

export async function listReadyTasks(
  config: ProjectConfig,
  projectRoot: string,
  runner: CommandRunner,
  onWarning: (message: string) => void = message => { process.stderr.write(`${message}\n`); },
): Promise<ReadyTask[]> {
  const result = await runner.run(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      config.repo,
      "--state",
      "open",
      "--author",
      "@me",
      "--limit",
      "100",
      "--json",
      "number,title,body",
    ],
    projectRoot,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Could not load ready DevOS tasks: ${result.stderr.trim() || `gh exited ${result.exitCode}`}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub returned invalid task data");
  }

  if (!Array.isArray(value)) {
    throw new Error("GitHub returned invalid task data");
  }

  const tasks: ReadyTask[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.number !== "number" ||
      typeof record.title !== "string" ||
      typeof record.body !== "string"
    ) {
      continue;
    }

    let task: ReadyTask | null;
    try {
      task = parseReadyTaskBody(record.body, config.repo, record.number, record.title);
    } catch (error) {
      onWarning(`Skipping Issue #${record.number}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (task && !(await isTaskCompleted(projectRoot, task.issue))) {
      tasks.push(task);
    }
  }

  return tasks.sort((a, b) => a.issue - b.issue);
}

export async function loadReadyTask(
  config: ProjectConfig,
  issue: number,
  projectRoot: string,
  runner: CommandRunner,
  allowClosed = false,
  allowCompleted = false,
): Promise<ReadyTask> {
  const result = await runner.run(
    "gh",
    [
      "issue",
      "view",
      String(issue),
      "--repo",
      config.repo,
      "--json",
      "number,title,body,state",
    ],
    projectRoot,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Could not load DevOS task #${issue}: ${result.stderr.trim() || `gh exited ${result.exitCode}`}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error(`GitHub returned invalid data for task #${issue}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub returned invalid data for task #${issue}`);
  }

  const record = value as Record<string, unknown>;
  const loadableState =
    record.state === "OPEN" || (allowClosed && record.state === "CLOSED");
  if (
    !loadableState ||
    record.number !== issue ||
    typeof record.title !== "string" ||
    typeof record.body !== "string"
  ) {
    throw new Error(`Issue #${issue} is not an open ready DevOS task`);
  }

  const task = parseReadyTaskBody(
    record.body,
    config.repo,
    issue,
    record.title,
  );
  if (!task) {
    throw new Error(`Issue #${issue} is not a ready DevOS task`);
  }
  if (!allowCompleted && await isTaskCompleted(projectRoot, issue)) {
    throw new Error(
      `Issue #${issue} is already completed; use restart to replan and run it again`,
    );
  }
  return task;
}

export function parseReadyTaskBody(
  body: string,
  repo: string,
  issue: number,
  title: string,
): ReadyTask | null {
  const markerIndex = body.indexOf(TASK_MARKER);
  if (markerIndex < 0) return null;

  const afterMarker = body.slice(markerIndex + TASK_MARKER.length);
  const match = afterMarker.match(/^\s*```json\s*\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(`Issue #${issue} has malformed DEVOS_TASK_V1 data`);
  }

  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error(`Issue #${issue} has invalid DEVOS_TASK_V1 JSON`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Issue #${issue} has invalid DEVOS_TASK_V1 data`);
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      key => key !== "version" && key !== "mode" && key !== "workflow",
    ) ||
    record.version !== 1 ||
    (record.mode !== "run" && record.mode !== "restart")
  ) {
    throw new Error(`Issue #${issue} has invalid DEVOS_TASK_V1 data`);
  }

  const workflow = parseWorkflow(record.workflow);
  if (workflow.task.repo !== repo || workflow.task.issue !== issue) {
    throw new Error(
      `Issue #${issue} workflow does not match project task ${repo}#${issue}`,
    );
  }

  return {
    issue,
    title,
    mode: record.mode,
    workflow,
  };
}

export function parseGitHubRepo(remote: string): string {
  const ssh = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;

  const https = remote.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;

  throw new Error(
    `DevOS supports GitHub origin remotes; could not parse: ${remote || "(empty)"}`,
  );
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid .devos/config.json");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      key => key !== "version" && key !== "repo" && key !== "chatgptProjectUrl",
    ) ||
    record.version !== 1 ||
    typeof record.repo !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(record.repo) ||
    (record.chatgptProjectUrl !== undefined &&
      typeof record.chatgptProjectUrl !== "string")
  ) {
    throw new Error("Invalid .devos/config.json");
  }

  if (record.chatgptProjectUrl !== undefined) {
    const value = record.chatgptProjectUrl.trim();
    if (!value) throw new Error("Invalid .devos/config.json");
    validateChatGptUrl(value);
    return { version: 1, repo: record.repo, chatgptProjectUrl: value };
  }

  return { version: 1, repo: record.repo };
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
