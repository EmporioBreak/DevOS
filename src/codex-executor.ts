import type { CommandRunner } from "./command-runner.js";
import type { Executor, WorkerRequest } from "./executor.js";
import type { WorkerOutput } from "./workflow.js";
import { parseDevosResult } from "./result.js";
import { prepareCodexSkills } from "./codex-skills.js";

export class CodexResumeUnavailableError extends Error {
  readonly safeToRetryFresh = true;

  constructor(
    readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexResumeUnavailableError";
  }
}

export function isCodexResumeUnavailableError(
  error: unknown,
): error is CodexResumeUnavailableError {
  return error instanceof CodexResumeUnavailableError;
}

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
    if (request.codexSkills)
      await prepareCodexSkills(request.projectRoot, request.codexSkills);
    const args = request.sessionId
      ? buildCodexResumeArgs(
          request.projectRoot,
          request.sessionId,
          request.prompt,
          this.options,
        )
      : buildCodexArgs(request.projectRoot, request.prompt, this.options);

    let reportedSessionId: string | undefined;
    const reportSession = async (stdout: string) => {
      const event = parseEvents(stdout).find(event => event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id.trim());
      if (!event) return;
      const id = event.thread_id as string;
      if (request.sessionId && id !== request.sessionId) throw new Error(`Codex resume changed session id: expected ${request.sessionId}, received ${id}`);
      if (reportedSessionId && id !== reportedSessionId) throw new Error("Codex changed session id during execution");
      if (!reportedSessionId) {
        await request.onSession?.(id);
        reportedSessionId = id;
      }
    };
    const result = await this.runner.run("codex", args, request.projectRoot, request.prompt, {
      onOutput: stdout => reportSession(stdout.slice(0, stdout.lastIndexOf("\n") + 1)),
      completeWhenOutput: stdout => isCompleteWorkerOutput(stdout, request.sessionId),
    });

    await reportSession(result.stdout);
    if (result.exitCode !== 0 && result.completedEarly !== true) {
      const message =
        `Codex exited with code ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`;
      if (
        request.sessionId &&
        isResumeUnavailableBeforeExecution(result.stdout, result.stderr)
      ) {
        throw new CodexResumeUnavailableError(request.sessionId, message);
      }
      throw new Error(message);
    }

    const failure = parseEvents(result.stdout).find(event => event.type === "turn.failed" || event.type === "error");
    if (failure) throw new Error(`Codex logical failure: ${JSON.stringify(failure)}`);

    const sessionId = parseThreadId(result.stdout);
    if (request.sessionId && sessionId !== request.sessionId) {
      throw new Error(
        `Codex resume changed session id: expected ${request.sessionId}, received ${sessionId}`,
      );
    }

    if (!isCompleteWorkerOutput(`${result.stdout}\n`, request.sessionId)) {
      throw new Error("Codex did not complete a valid worker turn");
    }
    return {
      text: parseFinalAgentMessage(result.stdout),
      sessionId,
    };
  }
}

function isCompleteWorkerOutput(stdout: string, expectedSessionId?: string): boolean {
  // Only a complete JSONL record can end a live child; a trailing partial line may
  // still be followed by more output that changes which agent_message is final.
  if (!stdout.endsWith("\n")) return false;
  try {
    const events = parseEvents(stdout);
    const sessionId = parseThreadId(stdout);
    if (expectedSessionId && sessionId !== expectedSessionId) return false;
    if (events.some(event => event.type === "turn.failed" || event.type === "error")) return false;

    let finalAgentMessageIndex = -1;
    let finalAgentMessage: string | undefined;
    for (const [index, event] of events.entries()) {
      if (
        event.type === "item.completed" &&
        isRecord(event.item) &&
        event.item.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        finalAgentMessageIndex = index;
        finalAgentMessage = event.item.text;
      }
    }
    if (finalAgentMessage === undefined) return false;
    parseDevosResult(finalAgentMessage);

    return events.some((event, index) => index > finalAgentMessageIndex && event.type === "turn.completed");
  } catch {
    return false;
  }
}

export function buildCodexArgs(
  projectRoot: string,
  _prompt: string,
  options: CodexOptions = {},
): string[] {
  const args = ["exec", "-C", projectRoot];
  appendRootOptions(args, options);
  appendRunOptions(args, options);
  args.push("--json");
  return args;
}

export function buildCodexResumeArgs(
  projectRoot: string,
  sessionId: string,
  _prompt: string,
  options: CodexOptions = {},
): string[] {
  const args = ["exec", "-C", projectRoot];
  appendRootOptions(args, options);
  args.push("resume", sessionId);
  appendRunOptions(args, options);
  args.push("--json");
  return args;
}

function appendRootOptions(args: string[], options: CodexOptions): void {
  if (options.sandbox) args.push("--sandbox", options.sandbox);
}

function appendRunOptions(args: string[], options: CodexOptions): void {
  if (options.model) args.push("-m", options.model);
  if (options.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
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

  if (!finalMessage) throw new Error("Codex did not emit a final agent message");
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
      // Non-JSON diagnostics are ignored.
    }
  }

  return events;
}

function isResumeUnavailableBeforeExecution(
  stdout: string,
  stderr: string,
): boolean {
  const events = parseEvents(stdout);
  const executionStarted = events.some(event =>
    event.type === "thread.started" ||
    event.type === "turn.started" ||
    event.type === "item.started" ||
    event.type === "item.completed",
  );
  if (executionStarted) return false;

  const diagnostics = `${stderr}\n${stdout}`;
  return /(?:thread|session|resume).*(?:not found|unknown|missing|does not exist|failed to (?:load|find|resume)|cannot (?:load|find|resume)|unable to (?:load|find|resume))/i.test(
    diagnostics,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
