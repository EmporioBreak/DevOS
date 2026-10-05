import type { CommandRunner } from "./command-runner.js";
import type { Executor, WorkerRequest } from "./executor.js";
import type { WorkerOutput } from "./workflow.js";

export interface CodexOptions {
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  sandbox?: "read-only" | "workspace-write";
}

export class CodexExecutor implements Executor {
  readonly kind = "codex" as const;

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: CodexOptions = {},
  ) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    const result = await this.runner.run(
      "codex",
      buildCodexArgs(request.projectRoot, request.prompt, this.options),
      request.projectRoot,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Codex exited with code ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
      );
    }

    return {
      text: parseFinalAgentMessage(result.stdout),
      sessionId: parseThreadId(result.stdout),
    };
  }
}

export function buildCodexArgs(
  projectRoot: string,
  prompt: string,
  options: CodexOptions = {},
): string[] {
  const args = ["exec", "-C", projectRoot];

  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }

  if (options.model) {
    args.push("-m", options.model);
  }

  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }

  args.push("--json", prompt);
  return args;
}

export function parseThreadId(stdout: string): string {
  for (const event of parseEvents(stdout)) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      return event.thread_id;
    }
  }

  throw new Error("Codex did not emit thread.started");
}

export function parseFinalAgentMessage(stdout: string): string {
  let finalMessage: string | undefined;

  for (const event of parseEvents(stdout)) {
    if (
      event.type === "item.completed" &&
      isRecord(event.item) &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalMessage = event.item.text;
    }
  }

  if (!finalMessage) {
    throw new Error("Codex did not emit a final agent message");
  }

  return finalMessage;
}

function parseEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) events.push(value);
    } catch {
      // Codex may mix diagnostics with JSON events; non-JSON lines are ignored.
    }
  }

  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
