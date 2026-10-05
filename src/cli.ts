#!/usr/bin/env node

import { resolve } from "node:path";
import { ChatGptBrowserExecutor } from "./chatgpt-browser-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { LocalCommandRunner } from "./command-runner.js";
import { JsonStateStore } from "./json-state-store.js";
import { Orchestrator } from "./orchestrator.js";
import { loadWorkflow } from "./workflow-loader.js";

export interface RunCommand {
  workflowPath: string;
}

export function parseCliArgs(args: string[]): RunCommand {
  if (args.length !== 2 || args[0] !== "run" || !args[1]?.trim()) {
    throw new Error("Usage: devos run <workflow.json>");
  }

  return { workflowPath: args[1] };
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

  try {
    const state = await new Orchestrator({
      projectRoot: cwd,
      workflow,
      executors: new Map([
        ["codex", codex],
        ["chatgpt_browser", chatgpt],
      ]),
      stateStore: new JsonStateStore(cwd),
    }).run();

    process.stdout.write(
      `DevOS complete: ${state.completedRuns} worker runs.\n`,
    );
  } finally {
    await chatgpt.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DevOS failed: ${message}\n`);
    process.exitCode = 1;
  });
}
