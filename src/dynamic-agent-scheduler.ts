import { DynamicAgentDispatcher } from "./dynamic-agent-dispatch.js";
import { DynamicWakeDispatcher } from "./dynamic-agent-wake.js";
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
export interface DynamicWakeDrainReport {
  sent: string[];
  blocked: Array<{ commandId: string; recipientId: string;
    reason: "dispatch_uncertain" | "transport_error" }>;
}
export class DynamicAgentScheduler {
  constructor(private readonly store: DynamicAgentStore, private readonly dispatch: DynamicAgentDispatcher) {}
  /**
   * CoS bridge pendingWorkerRevivals() / requestWorkerRevivals():
   * drain wake commands independently of ordinary inbox Sends, with bounded
   * work and a durable claim-before-Send barrier in DynamicWakeDispatcher.
   * One uncertain recipient must not halt unrelated sleeping teammates.
   */
  async drainWakes(wake: DynamicWakeDispatcher, maxCommands = 16): Promise<DynamicWakeDrainReport> {
    if (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || maxCommands > 64)
      throw new Error("Invalid wake scheduler budget");
    const result: DynamicWakeDrainReport = { sent: [], blocked: [] };
    const attempted = new Set<string>();
    while (result.sent.length + result.blocked.length < maxCommands) {
      const state = await this.store.load();
      if (!state || state.ownerDecision === "approved") break;
      const command = state.wakeCommands?.find(c => c.state === "queued" && !attempted.has(c.id));
      if (!command) break;
      attempted.add(command.id);
      try {
        await wake.dispatch({task:state.task,commandId:command.id,recipientId:command.recipientId,
          conversationId:command.conversationId,wakeKey:command.wakeKey});
        result.sent.push(command.id);
      } catch {
        const after = await this.store.load();
        const claim = after?.wakeCommands?.find(c => c.id === command.id);
        result.blocked.push({commandId:command.id,recipientId:command.recipientId,
          reason: claim?.state === "claimed" ? "dispatch_uncertain" : "transport_error"});
      }
    }
    return result;
  }
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
        // CoS browser revival has its own durable, exact-chat command. The
        // ordinary send lane must never steal that message while worker wakes.
        if (state.wakeCommands?.some(cmd => cmd.state !== "alive" &&
          cmd.messageIds.includes(message.id))) return false;
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
