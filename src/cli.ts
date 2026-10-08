#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { loadChatGptBrowserConfig } from "./browser-config.js";
import {
  clearTaskCompleted,
  isTaskCompleted,
  recordTaskCompletion,
} from "./completed-tasks.js";
import { CodexExecutor } from "./codex-executor.js";
import { runChatAccessAdmin, type ChatAccessCommand } from "./chat-access-admin.js";
import { LocalCommandRunner } from "./command-runner.js";
import { debugLog } from "./debug-log.js";
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
import { acquireTaskLock } from "./task-lock.js";
import type { Workflow } from "./workflow.js";
import { loadWorkflow } from "./workflow-loader.js";
import {
  closeSharedBrowserRuntime,
  ensureSharedBrowserRuntime,
  runBrowserRuntime,
} from "./shared-browser-runtime.js";

export const cliBrowserRuntimeDeps = {
  ensure: ensureSharedBrowserRuntime,
  close: closeSharedBrowserRuntime,
};

import {
  connector,
  connectorBackgroundRunning,
  type ConnectorAction,
} from "./connector.js";

export type CliCommand =
  | { kind: "connector"; action: ConnectorAction }
  | { kind: "chat_access"; command: ChatAccessCommand }
  | { kind: "select" }
  | { kind: "run"; mode: "run" | "restart"; target: string };

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 0) {
    return { kind: "select" };
  }

  if (args[0] === "connector" && args[1] === "access") {
    if (args.length === 3 && args[2] === "list")
      return { kind: "chat_access", command: { action: "list" } };
    if (args.length === 5 && args[2] === "approve")
      return { kind: "chat_access", command: { action: "approve", fingerprint: args[3]!, url: args[4]! } };
    if (args.length === 4 && args[2] === "revoke")
      return { kind: "chat_access", command: { action: "revoke", fingerprint: args[3]! } };
  }
  if (
    args[0] === "connector" &&
    ["setup", "doctor", "run", "start", "stop", "status"].includes(
      args[1] ?? "",
    ) &&
    args.length === 2
  ) {
    return { kind: "connector", action: args[1] as ConnectorAction };
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
    "Usage: ./devos | ./devos <run|restart> <workflow.json|issue-number> | ./devos connector <setup|doctor|run|start|stop|status|access list|access approve <chat_ref> <chat_url>|access revoke <chat_ref>>",
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
  if (config) assertWorkflowMatchesProject(workflow, config);
  const taskLock = await acquireTaskLock(cwd, workflow.task);
  try {
  if (process.env.DEVOS_DEBUG === "1") {
    process.env.DEVOS_DEBUG_FILE = join(
      cwd,
      ".devos",
      "debug",
      `${encodeURIComponent(workflow.task.repo)}-issue-${workflow.task.issue}.jsonl`,
    );
    const runtimePath = process.argv[1] ?? "";
    debugLog("cli.run", {
      projectRoot: cwd,
      task: workflow.task,
      mode,
      runtimePath,
      runtimeMode: runtimePath.includes("/.devos/runtime/")
        ? "project_local"
        : "self_host",
    });
  }
  const stateStore = new JsonStateStore(cwd, workflow.task);
  const hasBrowserWorker = workflow.workers.some(worker => worker.executor === "chatgpt_browser");
  if (mode === "restart" && hasBrowserWorker) {
    await cliBrowserRuntimeDeps.close(cwd, workflow.task);
  }
  await prepareRunState(mode, stateStore);
  if (mode === "restart") {
    await clearTaskCompleted(cwd, workflow.task.issue);
  } else if (await isTaskCompleted(cwd, workflow.task.issue) && !(await stateStore.load())?.completionApproved) {
    throw new Error(
      `Issue #${workflow.task.issue} is already completed; use restart to replan and run it again`,
    );
  }
  const mainAgentDecision = workflow.owner?.mode === "main_agent"
    ? parseMainAgentDecision(process.env.DEVOS_OWNER_RESULT)
    : undefined;
  const commandRunner = new LocalCommandRunner();
  const codex = new CodexExecutor(commandRunner);
  const chatgpt = hasBrowserWorker
    ? await cliBrowserRuntimeDeps.ensure(
        cwd,
        workflow.task,
        loadChatGptBrowserConfig(process.env, config?.chatgptProjectUrl),
      )
    : undefined;

  const state = await new Orchestrator({
    projectRoot: cwd,
    workflow,
    executors: new Map<string, Executor>([
      ["codex", codex],
      ...(chatgpt ? [["chatgpt_browser", chatgpt] as const] : []),
    ]),
    stateStore,
    enableWorkerReports: hasBrowserWorker,
    ...(mainAgentDecision ? { mainAgentDecision } : {}),
    finalizeTask: async state => {
      if (hasBrowserWorker) await cliBrowserRuntimeDeps.close(cwd, workflow.task);
      await recordTaskCompletion(cwd, workflow.task.issue, state);
    },
    resolveTask: task => resolveTaskReference(task, cwd, commandRunner),
    onEvent: event => { debugLog("orchestrator.event", event); writeOrchestrationEvent(event); },
  }).run();
  return state;
  } finally {
    await taskLock.release();
  }
}

export function assertWorkflowMatchesProject(
  workflow: Workflow,
  config: ProjectConfig,
): void {
  if (workflow.task.repo !== config.repo) {
    throw new Error(`Workflow repository ${workflow.task.repo} does not match current project ${config.repo}`);
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
  if (args[0] === "--devos-browser-runtime") {
    await runBrowserRuntime(args.slice(1));
    return;
  }
  const command = parseCliArgs(args);

  if (command.kind === "connector") {
    await connector(command.action, cwd);
    return;
  }
  if (command.kind === "chat_access") {
    process.stdout.write(await runChatAccessAdmin(cwd, command.command));
    return;
  }

  if (process.env.DEVOS_MANAGE_BACKGROUND === "1") {
    const backgroundWasRunning = await connectorBackgroundRunning(cwd);
    if (!backgroundWasRunning) {
      await connector("start", cwd);
      if (command.kind === "select") return;
    }

    if (command.kind === "select") {
      process.stdout.write(
        "\nDevOS is running in background.\n" +
          "1. Open ready tasks\n" +
          "2. Show background status\n" +
          "3. Stop DevOS\n",
      );
      const control = createInterface({ input, output });
      try {
        const answer = (await control.question("\nSelect: ")).trim();
        if (answer === "2") {
          await connector("status", cwd);
          return;
        }
        if (answer === "3") {
          await connector("stop", cwd);
          return;
        }
        if (answer !== "1") throw new Error("Invalid selection");
      } finally {
        control.close();
      }
    }
  }

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
    const mainAgentDecision = parseMainAgentDecision(process.env.DEVOS_OWNER_RESULT);
    const pendingState = await new JsonStateStore(cwd, { repo: config.repo, issue }).load();
    const finalizationPending = pendingState?.completionApproved === true;
    const task = await loadReadyTask(
      config,
      issue,
      cwd,
      runner,
      mainAgentDecision !== undefined || command.mode === "restart" || finalizationPending,
      command.mode === "restart" || finalizationPending,
    );
    if (mainAgentDecision !== undefined) {
      assertMainAgentDecisionPending(pendingState, mainAgentDecision);
    }
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
    case "task_status":
      if (event.status === "running") {
        return `Task #${event.task.issue} — running (${event.resumed ? "resume" : "start"})\n`;
      }
      return `Task #${event.task.issue} — ${event.status}\n`;
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
    case "worker_session_recovered":
      return event.executor === "chatgpt_browser"
        ? `[${event.workerId}] ${event.executor} — saved session unusable; recovering in configured Project\n`
        : `[${event.workerId}] ${event.executor} — saved session unusable; starting fresh in project root\n`;
    case "main_agent_handoff":
      return "Main agent handoff\n";
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
  if (state.mainAgentReviewPending) {
    return `DEVOS_OWNER_HANDOFF ${JSON.stringify({
      status: "FINAL_REVIEW_REQUIRED",
      task: state.task ?? workflow.task,
    })}\n`;
  }

  const subject = label ? `${label}, ` : "";
  return `Task ${subject}completed (${state.completedRuns} worker runs).\n`;
}

export function writeRunResult(
  workflow: Workflow,
  state: RunState,
  label?: string,
): void {
  process.stdout.write(formatRunResult(workflow, state, label));
}

export function parseMainAgentDecision(
  value: string | undefined,
): "approved" | "changes_requested" | undefined {
  const decision = value?.trim();
  if (!decision) return undefined;
  if (decision === "approved" || decision === "changes_requested") {
    return decision;
  }
  throw new Error("DEVOS_OWNER_RESULT must be approved or changes_requested");
}

export function assertMainAgentDecisionPending(state: RunState | null, decision?: "approved" | "changes_requested"): void {
  if (state?.completionApproved && decision === "approved") return;
  if (!state?.mainAgentReviewPending) {
    throw new Error(
      "DEVOS_OWNER_RESULT requires an existing task waiting for final review",
    );
  }
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
    debugLog("cli.failure", { message });
    process.stderr.write(`DevOS failed: ${message}\n`);
    process.exitCode = 1;
  });
}
