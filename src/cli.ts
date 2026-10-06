#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { loadChatGptBrowserConfig } from "./browser-config.js";
import { ChatGptBrowserExecutor } from "./chatgpt-browser-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { LocalCommandRunner } from "./command-runner.js";
import type { Executor } from "./executor.js";
import { JsonStateStore } from "./json-state-store.js";
import {
  Orchestrator,
  type OrchestrationEvent,
  type RunState,
  type StateStore,
} from "./orchestrator.js";
import {
  listReadyTasks,
  loadOrCreateProjectConfig,
  loadReadyTask,
  type ProjectConfig,
  type ReadyTask,
} from "./ready-tasks.js";
import { resolveTaskReference } from "./task-reference.js";
import type { Workflow } from "./workflow.js";
import { loadWorkflow } from "./workflow-loader.js";

export type CliCommand =
  | { kind: "select" }
  | { kind: "run"; mode: "run" | "restart"; target: string };

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 0) {
    return { kind: "select" };
  }

  const mode = args[0];
  if (
    args.length === 2 &&
    (mode === "run" || mode === "restart") &&
    !!args[1]?.trim()
  ) {
    return { kind: "run", mode, target: args[1] };
  }

  throw new Error(
    "Usage: ./devos | ./devos <run|restart> <workflow.json|issue-number>",
  );
}

export async function prepareRunState(
  mode: "run" | "restart",
  stateStore: StateStore,
): Promise<void> {
  if (mode === "restart") {
    await stateStore.clear();
  }
}

export async function runWorkflow(
  workflow: Workflow,
  mode: "run" | "restart",
  cwd: string,
  config?: ProjectConfig,
): Promise<RunState> {
  const commandRunner = new LocalCommandRunner();
  const codex = new CodexExecutor(commandRunner);
  const chatgpt = new ChatGptBrowserExecutor(
    loadChatGptBrowserConfig(process.env, config?.chatgptProjectUrl),
  );
  const stateStore = new JsonStateStore(cwd, workflow.task);
  await prepareRunState(mode, stateStore);
  const ownerDecision = workflow.owner?.mode === "parent_process"
    ? parseParentOwnerDecision(process.env.DEVOS_OWNER_RESULT)
    : undefined;

  try {
    return await new Orchestrator({
      projectRoot: cwd,
      workflow,
      executors: new Map<string, Executor>([
        ["codex", codex],
        ["chatgpt_browser", chatgpt],
      ]),
      stateStore,
      ...(ownerDecision ? { ownerDecision } : {}),
      resolveTask: task => resolveTaskReference(task, cwd, commandRunner),
      onEvent: writeOrchestrationEvent,
    }).run();
  } finally {
    await chatgpt.close();
  }
}

export function chooseReadyTask(
  tasks: ReadyTask[],
  answer: string,
): ReadyTask {
  const selection = Number(answer.trim());
  if (
    !Number.isSafeInteger(selection) ||
    selection < 1 ||
    selection > tasks.length
  ) {
    throw new Error("Invalid task selection");
  }
  return tasks[selection - 1]!;
}

export async function main(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<void> {
  const command = parseCliArgs(args);

  if (command.kind === "select") {
    const runner = new LocalCommandRunner();
    const config = await loadOrCreateProjectConfig(cwd, runner);
    const tasks = await listReadyTasks(config, cwd, runner);

    if (tasks.length === 0) {
      process.stdout.write("No ready DevOS tasks.\n");
      return;
    }

    process.stdout.write(`Ready DevOS tasks for ${config.repo}:\n\n`);
    for (const [index, task] of tasks.entries()) {
      process.stdout.write(`${index + 1}. #${task.issue} ${task.title}\n`);
    }

    const rl = createInterface({ input, output });
    let task: ReadyTask;
    try {
      const answer = await rl.question("\nSelect task: ");
      task = chooseReadyTask(tasks, answer);
    } finally {
      rl.close();
    }

    process.stdout.write(`\nStarting #${task.issue}: ${task.title}\n`);
    const state = await runWorkflow(task.workflow, task.mode, cwd, config);
    writeRunResult(task.workflow, state, `#${task.issue}`);
    return;
  }

  const issue = parseIssueNumber(command.target);
  if (issue !== null) {
    const runner = new LocalCommandRunner();
    const config = await loadOrCreateProjectConfig(cwd, runner);
    const task = await loadReadyTask(config, issue, cwd, runner);
    const state = await runWorkflow(task.workflow, command.mode, cwd, config);
    writeRunResult(task.workflow, state, `#${task.issue}`);
    return;
  }

  const runner = new LocalCommandRunner();
  const config = await loadOrCreateProjectConfig(cwd, runner);
  const workflowPath = resolve(cwd, command.target);
  const workflow = await loadWorkflow(workflowPath);
  const state = await runWorkflow(workflow, command.mode, cwd, config);
  writeRunResult(workflow, state);
}

export function formatOrchestrationEvent(event: OrchestrationEvent): string {
  switch (event.type) {
    case "task_started":
      return `Task #${event.task.issue} ${event.resumed ? "resumed" : "started"}\n`;
    case "worker_started":
      if (event.executor === "chatgpt_browser") {
        return event.session === "resumed"
          ? `[${event.workerId}] ${event.executor} — resuming existing session\n`
          : `[${event.workerId}] ${event.executor} — starting fresh conversation\n`;
      }
      return `[${event.workerId}] ${event.executor} — starting\n`;
    case "worker_result":
      return `[${event.workerId}] ${event.executor} — ${event.status}\n`;
    case "transition":
      return `→ ${event.to}\n`;
    case "owner_handoff":
      return "Final review required by task owner\n";
  }
}

export function writeOrchestrationEvent(event: OrchestrationEvent): void {
  process.stdout.write(formatOrchestrationEvent(event));
}

export function formatRunResult(
  workflow: Workflow,
  state: RunState,
  label?: string,
): string {
  if (state.ownerReviewPending) {
    return `DEVOS_OWNER_HANDOFF ${JSON.stringify({
      status: "FINAL_REVIEW_REQUIRED",
      task: state.task ?? workflow.task,
    })}\n`;
  }

  const subject = label ? `${label}, ` : "";
  return `DevOS complete: ${subject}${state.completedRuns} worker runs.\n`;
}

export function writeRunResult(
  workflow: Workflow,
  state: RunState,
  label?: string,
): void {
  process.stdout.write(formatRunResult(workflow, state, label));
}

export function parseParentOwnerDecision(
  value: string | undefined,
): "approved" | "changes_requested" | undefined {
  const decision = value?.trim();
  if (!decision) return undefined;
  if (decision === "approved" || decision === "changes_requested") {
    return decision;
  }
  throw new Error("DEVOS_OWNER_RESULT must be approved or changes_requested");
}

export function parseIssueNumber(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const issue = Number(value);
  if (!Number.isSafeInteger(issue) || issue <= 0) {
    throw new Error("Issue number must be a positive integer");
  }
  return issue;
}

export function isCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DevOS failed: ${message}\n`);
    process.exitCode = 1;
  });
}
