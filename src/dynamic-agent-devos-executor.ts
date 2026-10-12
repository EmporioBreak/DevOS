import type { Executor, WorkerRequest } from "./executor.js";
import type { ExecutorKind, TaskRef, WorkerOutput } from "./workflow.js";
import { isSameChatGptConversation } from "./chatgpt-browser-executor.js";
import type { DynamicAgentBootstrapTransport } from "./dynamic-agent-bootstrap.js";
import type { DynamicMessageTransport } from "./dynamic-agent-dispatch.js";
import type { DynamicWakeTransport } from "./dynamic-agent-wake.js";

/**
 * Adapt the actual DevOS Executor.run(WorkerRequest) API to the CoS-derived
 * task-scoped bootstrap, ordinary-message and wake protocols.
 *
 * IMPORTANT: the executor's returned text/session alone is NOT provider
 * message acceptance or a worker grant. The host must independently prove
 * both kinds of evidence from native provider/turn telemetry.
 */
export interface DynamicTrustedExecutorHost {
  prepareBootstrap(input: {
    task: TaskRef; agentId: string; role: string; brief: string;
    executor: ExecutorKind; manifestSha256: string;
  }): Promise<WorkerRequest>;
  prepareMessage(input: Parameters<DynamicMessageTransport["send"]>[0]): Promise<WorkerRequest>;
  prepareWake(input: Parameters<DynamicWakeTransport["send"]>[0]): Promise<WorkerRequest>;

  /** Real worker session + signed exact task/skill identity, never model data. */
  verifiedBootstrap(input: {
    task: TaskRef; agentId: string; role: string; executor: ExecutorKind;
    manifestSha256: string; sessionId: string; output: WorkerOutput;
  }): Promise<string | null>;
  /** Provider-accepted turn / user message identity from trusted native trace. */
  verifiedProviderMessage(input: {
    task: TaskRef; workerId: string; sessionId: string;
    output: WorkerOutput; commandId: string;
  }): Promise<string | null>;
}
function sameTask(a: TaskRef, b: TaskRef): boolean {
  return a.repo === b.repo && a.issue === b.issue && (a.pr ?? null) === (b.pr ?? null);
}
function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error("DYNAMIC_EXECUTOR: " + message);
}
function verifiedSession(expected: string, actual: string | undefined, executor: ExecutorKind): void {
  expect(typeof actual === "string" && !!actual.trim(), "Executor did not prove its own session identity");
  expect(executor === "chatgpt_browser" ?
    isSameChatGptConversation(expected, actual) : expected === actual,
    "Executor changed the exact saved worker conversation/thread");
}
export class DynamicDevosExecutorAdapter
  implements DynamicAgentBootstrapTransport, DynamicMessageTransport, DynamicWakeTransport {
  constructor(private readonly executors: Record<ExecutorKind, Executor>,
    private readonly host: DynamicTrustedExecutorHost) {
    expect(executors.codex.kind === "codex" && executors.chatgpt_browser.kind === "chatgpt_browser",
      "Executor registry has conflicting provider kinds");
  }
  private async run(kind: ExecutorKind, request: WorkerRequest, task: TaskRef,
    workerId: string, fresh: boolean): Promise<WorkerOutput> {
    expect(!!request.projectRoot && typeof request.prompt === "string" &&
      !!request.prompt.trim() && request.workerId === workerId,
      "Host did not prepare an exact worker request");
    if (kind === "chatgpt_browser") {
      expect(request.enforceProjectScope === true &&
        !!request.reportTurn && sameTask(request.reportTurn.task, task),
        "Browser requires exact Project and authenticated report-turn custody");
    } else {
      expect(request.codexSkills?.mandatory === true &&
        request.codexSkills.workerId === workerId &&
        sameTask(request.codexSkills.task, task),
        "Codex requires task-local mandatory signed skill assignment");
    }
    if (fresh) expect(request.sessionId === undefined,
      "Fresh bootstrap cannot reuse or hijack another existing conversation");
    else expect(typeof request.sessionId === "string" && !!request.sessionId.trim(),
      "Existing worker turn must name its authentic saved conversation");
    // The already established producer-side broker fence is the sole Send
    // authority. Do not retry this run on transport error, timeout or SIGKILL.
    return this.executors[kind].run(request);
  }

  async start(input: Parameters<DynamicAgentBootstrapTransport["start"]>[0]): Promise<{
    sessionId: string; sessionFingerprint: string;
  }> {
    const request = await this.host.prepareBootstrap(input);
    const output = await this.run(input.executor, request, input.task, input.agentId, true);
    const sessionId = output.sessionId;
    expect(sessionId && !!sessionId.trim(), "Bootstrap has no provider-established conversation");
    const sessionFingerprint = await this.host.verifiedBootstrap({
      ...input, sessionId, output
    });
    expect(sessionFingerprint && !!sessionFingerprint.trim(),
      "Bootstrap lacks independently verified worker session binding");
    return {sessionId, sessionFingerprint};
  }

  async send(input: Parameters<DynamicMessageTransport["send"]>[0]): Promise<{ providerMessageId: string }>;
  async send(input: Parameters<DynamicWakeTransport["send"]>[0]): Promise<{ providerMessageId: string }>;
  async send(input: Parameters<DynamicMessageTransport["send"]>[0] |
    Parameters<DynamicWakeTransport["send"]>[0]): Promise<{ providerMessageId: string }> {
    if ("message" in input) {
      const kind = input.recipient.executor;
      expect(kind === "chatgpt_browser" || kind === "codex", "Cannot send worker work to Main Agent via worker executor");
      expect(!!input.recipient.sessionId, "No saved worker session");
      const request = await this.host.prepareMessage(input);
      verifiedSession(input.recipient.sessionId, request.sessionId, kind);
      const output = await this.run(kind, request, input.task, input.recipient.id, false);
      verifiedSession(input.recipient.sessionId, output.sessionId, kind);
      const providerMessageId = await this.host.verifiedProviderMessage({
        task: input.task, workerId: input.recipient.id, sessionId: input.recipient.sessionId,
        output, commandId: input.message.id
      });
      expect(providerMessageId && !!providerMessageId.trim(),
        "External worker turn completed without independent provider Send receipt");
      return {providerMessageId};
    }

    const request = await this.host.prepareWake(input);
    // Source COS bridge's exact-chat wake reuses the existing executor owner:
    // Camoufox resumes the exact browser chat; native Codex resumes its
    // original thread. Never spawn a new session to "repair" a missing one.
    const kind = input.executor;
    expect(kind === "chatgpt_browser" || kind === "codex",
      "Wake executor kind changed");
    verifiedSession(input.conversationId, request.sessionId, kind);
    const output = await this.run(kind, request, input.task, input.recipientId, false);
    verifiedSession(input.conversationId, output.sessionId, kind);
    const providerMessageId = await this.host.verifiedProviderMessage({
      task: input.task,workerId:input.recipientId,sessionId:input.conversationId,
      output,commandId:input.commandId,
    });
    expect(providerMessageId && !!providerMessageId.trim(),
      "Wake completed without independently verified provider acceptance");
    return {providerMessageId};
  }
}
