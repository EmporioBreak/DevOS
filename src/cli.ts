#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatGptBrowserExecutor } from "./chatgpt-browser-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { LocalCommandRunner } from "./command-runner.js";
import type { Executor } from "./executor.js";
import { JsonStateStore } from "./json-state-store.js";
import { Orchestrator, type StateStore } from "./orchestrator.js";
import { loadWorkflow } from "./workflow-loader.js";

export interface RunCommand {
  mode: "run" | "restart";
  workflowPath: string;
}

export function parseCliArgs(args: string[]): RunCommand {
  const mode = args[0];
  if (
    args.length !== 2 ||
    (mode !== "run" && mode !== "restart") ||
    !args[1]?.trim()
  ) {
    throw new Error("Usage: devos <run|restart> <workflow.json>");
  }

  return { mode, workflowPath: args[1] };
}

export async function prepareRunState(
  command: RunCommand,
  stateStore: StateStore,
): Promise<void> {
  if (command.mode === "restart") {
    await stateStore.clear();
  }
}

export async function main(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<void> {
  const command = parseCliArgs(args);
  const workflowPath = resolve(cwd, command.workflowPath);
  const workflow = await loadWorkflow(workflowPath);

  const commandRunner = new LocalCommandRunner();
  const codex = new CodexExecutor(commandRunner);
  const chatgpt = new ChatGptBrowserExecutor();

  const stateStore = new JsonStateStore(cwd, workflow.task);
  await prepareRunState(command, stateStore);

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

    process.stdout.write(
      `DevOS complete: ${state.completedRuns} worker runs.\n`,
    );
  } finally {
    await chatgpt.close();
  }
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
