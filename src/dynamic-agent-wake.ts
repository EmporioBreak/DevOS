import type { ExecutorKind, TaskRef } from "./workflow.js";
import { DynamicAgentBroker, DynamicAgentStore, type DynamicWakeLease,
  type DynamicWakeCommand, type DynamicMessage } from "./dynamic-agent-runtime.js";

/**
 * The existing Camoufox browser owner or Codex session gateway implements this.
 * A Send result is NOT proof unless the host independently correlates a real
 * provider-accepted message identity to the exact existing conversation.
 */
export interface DynamicWakeTransport {
  send(input: {
    task: TaskRef; commandId: string; wakeKey: string;
    conversationId: string; recipientId: string; executor: ExecutorKind;
    messages: ReadonlyArray<Pick<DynamicMessage, "id" | "from" | "kind" | "body">>;
  }): Promise<{ providerMessageId: string }>;
}

/**
 * Source port: CoS bridge.ts CommandSpec(type="revive"), redeem and send ACK.
 * Never creates a fresh chat, synthesizes a provider id or blindly replays an
 * uncertain send. Browser ownership/custody remains with the existing DevOS
 * host adapter; this class only defines its durable transactional boundary.
 */
export class DynamicWakeDispatcher {
  constructor(private readonly broker: DynamicAgentBroker, private readonly store: DynamicAgentStore,
    private readonly transport: DynamicWakeTransport) {}

  async dispatch(lease: DynamicWakeLease): Promise<DynamicWakeCommand> {
    const state = await this.store.load();
    if (!state || state.task.repo !== lease.task.repo ||
      state.task.issue !== lease.task.issue || (state.task.pr ?? null) !== (lease.task.pr ?? null))
      throw new Error("Wake task identity mismatch");
    const command = state.wakeCommands?.find(c => c.id === lease.commandId &&
      c.recipientId === lease.recipientId && c.conversationId === lease.conversationId &&
      c.wakeKey === lease.wakeKey);
    const agent = state.agents.find(a => a.id === lease.recipientId);
    if (!command || command.state !== "queued" || agent?.status !== "waking" ||
      agent.sessionId !== command.conversationId ||
      (agent.executor !== "chatgpt_browser" && agent.executor !== "codex"))
      throw new Error("Wake not queued for exact owned chat/thread");
    const messages = command.messageIds.map(id => state.messages.find(m => m.id === id));
    if (messages.some(m => !m || m.to !== command.recipientId || m.state !== "queued"))
      throw new Error("Wake message set changed before dispatch");

    // An irrevocable claim fences the Send before touching the composer.
    await this.broker.claimWake(lease);
    const result = await this.transport.send({
      task: state.task, commandId: command.id, wakeKey: command.wakeKey,
      recipientId: command.recipientId, conversationId: command.conversationId,
      executor: agent.executor,
      messages: messages.map(m => ({id:m!.id,from:m!.from,kind:m!.kind,body:m!.body}))
    });
    if (!result.providerMessageId?.trim()) throw new Error("Wake provider acceptance not proven");
    return this.broker.confirmWake(lease, { ...lease, providerMessageId: result.providerMessageId });
  }
}
