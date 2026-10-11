import { DynamicAgentDispatcher } from "./dynamic-agent-dispatch.js";
import { DynamicAgentStore } from "./dynamic-agent-runtime.js";

export interface DynamicDrainReport {
  sent: string[];
  blocked: Array<{ messageId: string; recipientId: string; reason: "missing_session" | "dispatch_uncertain" | "transport_error" }>;
}

/**
 * One bounded, explicitly invoked queue-drain pass. It NEVER decides the next
 * worker from a signed workflow table and never polls/sends an uncertain turn.
 * A subsequent authenticated message/event can schedule another pass.
 */
export class DynamicAgentScheduler {
  constructor(private readonly store: DynamicAgentStore, private readonly dispatch: DynamicAgentDispatcher) {}
  async drain(maxMessages = 16): Promise<DynamicDrainReport> {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 64)
      throw new Error("Invalid dynamic scheduler budget");
    const result: DynamicDrainReport = { sent: [], blocked: [] };
    const attempted = new Set<string>();
    while (result.sent.length + result.blocked.length < maxMessages) {
      const state = await this.store.load();
      if (!state || state.ownerDecision === "approved") break;
      const candidate = state.messages.find(message => {
        if (attempted.has(message.id) || message.state !== "queued") return false;
        const prior = state.messages.find(m => m.to === message.to && m.state !== "acked");
        return prior === message;
      });
      if (!candidate) break;
      attempted.add(candidate.id);
      const recipient = state.agents.find(agent => agent.id === candidate.to);
      if (!recipient?.sessionId || recipient.status === "blocked") {
        result.blocked.push({ messageId: candidate.id, recipientId: candidate.to, reason: "missing_session" });
        continue;
      }
      try {
        await this.dispatch.dispatch({ task: state.task, recipientId: candidate.to, messageId: candidate.id });
        result.sent.push(candidate.id);
      } catch {
        // The dispatcher already fenced the uncertain send or failed before
        // claim. Do not retry without proved no-submit.
        const current = await this.store.load();
        const status = current?.messages.find(m => m.id === candidate.id)?.state;
        result.blocked.push({ messageId: candidate.id, recipientId: candidate.to,
          reason: status === "dispatch_uncertain" ? "dispatch_uncertain" : "transport_error" });
      }
    }
    return result;
  }
}
