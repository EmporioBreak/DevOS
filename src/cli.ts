#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { ChatGptBrowserExecutor } from "./chatgpt-browser-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { LocalCommandRunner } from "./command-runner.js";
import type { Executor } from "./executor.js";
import { JsonStateStore } from "./json-state-store.js";
import { Orchestrator, type StateStore } from "./orchestrator.js";
import {
  clearTaskCompletion,
  isTaskCompleted,
  listReadyTasks,
  loadOrCreateProjectConfig,
  loadReadyTask,
  markTaskCompleted,
  type ReadyTask,
} from "./ready-tasks.js";
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
): Promise<number> {
  const commandRunner = new LocalCommandRunner();
  const codex = new CodexExecutor(commandRunner);
  const chatgpt = new ChatGptBrowserExecutor();
  const stateStore = new JsonStateStore(cwd, workflow.task);
  await prepareRunState(mode, stateStore);

  try {
    const state = await new Orchestrator({
      projectRoot: cwd,
      workflow,
      executors: new Map<string, Executor>([
        ["codex", codex],
        ["chatgpt_browser", chatgpt],
      ]),
      stateStore,
    }).run();

    return state.completedRuns;
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
    const completedRuns = await runWorkflow(task.workflow, task.mode, cwd);
    await markTaskCompleted(cwd, task.issue);
    process.stdout.write(
      `DevOS complete: #${task.issue}, ${completedRuns} worker runs.\n`,
    );
    return;
  }

  const issue = parseIssueNumber(command.target);
  if (issue !== null) {
    const runner = new LocalCommandRunner();
    const config = await loadOrCreateProjectConfig(cwd, runner);
    const task = await loadReadyTask(
      config,
      issue,
      cwd,
      runner,
      command.mode === "restart",
    );
    if (command.mode === "restart") {
      await clearTaskCompletion(cwd, issue);
    }
    const completedRuns = await runWorkflow(task.workflow, command.mode, cwd);
    await markTaskCompleted(cwd, task.issue);
    process.stdout.write(
      `DevOS complete: #${task.issue}, ${completedRuns} worker runs.\n`,
    );
    return;
  }

  const workflowPath = resolve(cwd, command.target);
  const workflow = await loadWorkflow(workflowPath);
  if (command.mode === "run" && await isTaskCompleted(cwd, workflow.task.issue)) {
    throw new Error(
      `Issue #${workflow.task.issue} has already completed. Use ./devos restart ${command.target} after an explicit replan.`,
    );
  }
  if (command.mode === "restart") {
    await clearTaskCompletion(cwd, workflow.task.issue);
  }
  const completedRuns = await runWorkflow(workflow, command.mode, cwd);
  await markTaskCompleted(cwd, workflow.task.issue);
  process.stdout.write(`DevOS complete: ${completedRuns} worker runs.\n`);
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
