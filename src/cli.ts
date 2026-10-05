#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ChatGptBrowserExecutor } from "./chatgpt-browser-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { LocalCommandRunner } from "./command-runner.js";
import type { Executor } from "./executor.js";
import {
  GhIssueDispatchSource,
  JsonDispatchStore,
  runDispatchCycle,
  type DispatchMode,
} from "./github-dispatch.js";
import { JsonStateStore } from "./json-state-store.js";
import { Orchestrator, type StateStore } from "./orchestrator.js";
import type { Workflow } from "./workflow.js";
import { loadWorkflow } from "./workflow-loader.js";

export interface WorkflowCommand {
  kind: "workflow";
  mode: "run" | "restart";
  workflowPath: string;
}

export interface WatchCommand {
  kind: "watch";
  repo: string;
}

export type CliCommand = WorkflowCommand | WatchCommand;

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 2 && args[0] === "watch" && isRepoName(args[1])) {
    return { kind: "watch", repo: args[1] };
  }

  const mode = args[0];
  if (
    args.length === 2 &&
    (mode === "run" || mode === "restart") &&
    !!args[1]?.trim()
  ) {
    return { kind: "workflow", mode, workflowPath: args[1] };
  }

  throw new Error(
    "Usage: devos <run|restart> <workflow.json> | devos watch <owner/repo>",
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
  mode: DispatchMode,
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

export async function main(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<void> {
  const command = parseCliArgs(args);

  if (command.kind === "watch") {
    await watch(command.repo, cwd);
    return;
  }

  const workflowPath = resolve(cwd, command.workflowPath);
  const workflow = await loadWorkflow(workflowPath);
  const completedRuns = await runWorkflow(workflow, command.mode, cwd);
  process.stdout.write(`DevOS complete: ${completedRuns} worker runs.\n`);
}

export async function watch(repo: string, cwd: string): Promise<never> {
  const source = new GhIssueDispatchSource(new LocalCommandRunner());
  const store = new JsonDispatchStore(cwd);

  process.stdout.write(`DevOS watching ${repo} for task dispatches.\n`);

  while (true) {
    const result = await runDispatchCycle({
      repo,
      cwd,
      source,
      store,
      execute: async (dispatch, mode) => {
        const completedRuns = await runWorkflow(dispatch.workflow, mode, cwd);
        process.stdout.write(
          `DevOS dispatch ${dispatch.id} complete: ${completedRuns} worker runs.\n`,
        );
      },
    });

    if (result?.status === "blocked") {
      process.stderr.write(
        `DevOS dispatch ${result.key} blocked: ${result.error ?? "unknown error"}\n`,
      );
    }

    await sleep(5_000);
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

function isRepoName(value: string | undefined): value is string {
  if (!value) return false;
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every(part => part.trim().length > 0 && !part.includes(" "))
  );
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DevOS failed: ${message}\n`);
    process.exitCode = 1;
  });
}
