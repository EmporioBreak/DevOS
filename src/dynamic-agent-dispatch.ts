import type { TaskRef } from "./workflow.js";
import { DynamicAgentBroker, DynamicAgentStore, type DynamicMessage,
  type DynamicTransportLease, type DynamicAgent } from "./dynamic-agent-runtime.js";

/** Adapter MUST return a provider-accepted message identity, not a DOM click or terminal stdout. */
export interface DynamicMessageTransport {
  send(input: { task: TaskRef; recipient: Pick<DynamicAgent, "id" | "executor" | "sessionId">;
    message: DynamicMessage }): Promise<{ providerMessageId: string }>;
}

/**
 * Thin fail-closed host dispatch seam. Uses existing browser/Codex transports only
 * after their exact-session and receipt verification have been integrated. It
 * does not start profiles, repair sessions, synthesize receipts or auto-replay.
 */
export class DynamicAgentDispatcher {
  constructor(private readonly broker: DynamicAgentBroker, private readonly store: DynamicAgentStore,
    private readonly transport: DynamicMessageTransport) {}

  async dispatch(lease: DynamicTransportLease): Promise<DynamicMessage> {
    const state = await this.store.load();
    if (!state || state.task.repo !== lease.task.repo || state.task.issue !== lease.task.issue ||
      (state.task.pr ?? null) !== (lease.task.pr ?? null)) throw new Error("Dispatch task mismatch");
    const recipient = state.agents.find(a => a.id === lease.recipientId);
    const message = state.messages.find(m => m.id === lease.messageId && m.to === lease.recipientId);
    if (!recipient || !message || !recipient.sessionId ||
      recipient.status === "blocked" || recipient.status === "sleeping" ||
      recipient.status === "waking") {
      throw new Error("Dispatch requires exact saved recipient session and message");
    }
    // Durable fence must be recorded before any transport/browser side effect.
    await this.broker.claimForTransport(lease);
    // Any thrown/ambiguous result intentionally keeps the dispatch_uncertain fence.
    const result = await this.transport.send({ task: state.task,
      recipient: { id: recipient.id, executor: recipient.executor, sessionId: recipient.sessionId },
      message });
    if (!result.providerMessageId?.trim()) throw new Error("Transport did not prove provider acceptance");
    // This remains subject to the broker's independent host verification.
    return this.broker.confirmTransportDelivery(lease, { task: state.task,
      messageId: message.id, providerMessageId: result.providerMessageId });
  }
}
