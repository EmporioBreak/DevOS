import type { ExecutorKind, TaskRef } from "./workflow.js";
import { DynamicAgentBroker, DynamicAgentStore, type DynamicAgent,
  type DynamicAgentPolicy, type DynamicSpawnLease } from "./dynamic-agent-runtime.js";

/**
 * A DevOS host adapter supplies the exact provider-created session and proof.
 * Neither a model-written URL nor a browser DOM draft is a confirmed bootstrap.
 * Real Camoufox/Codex implementations must reuse the original custody owner.
 */
export interface DynamicAgentBootstrapTransport {
  start(input: { task: TaskRef; agentId: string; role: string; brief: string;
    executor: ExecutorKind; manifestSha256: string }): Promise<{
    sessionId: string; sessionFingerprint: string;
  }>;
}

/**
 * CoS agents.ts stageSpawn() / tools-core.ts acceptAgentMutation() /
 * requestWorkerBootstraps() adapted for DevOS:
 *
 * 1. requestSpawn has already durably reserved the exact worker.
 * 2. claimSpawnBootstrap durably fences execution BEFORE opening provider chat.
 * 3. transport.start is the sole authorized external side effect.
 * 4. bindSpawn independently verifies, then durably publishes the new member.
 *
 * A timeout, crash or unknown provider outcome after (2) leaves a deliberately
 * uncertain claim. Neither this class nor a restart may replay that bootstrap.
 */
export class DynamicAgentBootstrapper {
  constructor(private readonly policy: DynamicAgentPolicy,
    private readonly store: DynamicAgentStore,
    private readonly broker: DynamicAgentBroker,
    private readonly transport: DynamicAgentBootstrapTransport) {}

  async bootstrap(lease: DynamicSpawnLease): Promise<DynamicAgent> {
    const state = await this.store.load();
    if (!state || state.task.repo !== lease.task.repo || state.task.issue !== lease.task.issue ||
      (state.task.pr ?? null) !== (lease.task.pr ?? null) ||
      state.ownerDecision === "approved")
      throw new Error("Bootstrap task identity mismatch");
    const pending = state.pendingSpawns?.find(p =>
      p.id === lease.agentId && p.idempotencyKey === lease.idempotencyKey);
    if (!pending || pending.state !== "reserved")
      throw new Error("Bootstrap is not reserved; retry may duplicate an existing provider chat");
    const role = this.policy.roles[pending.role];
    if (!role || this.policy.task.repo !== state.task.repo ||
      this.policy.task.issue !== state.task.issue ||
      (this.policy.task.pr ?? null) !== (state.task.pr ?? null))
      throw new Error("Unapproved bootstrap skill/task policy");
    // The broker rechecks policy hash, host lease authority and state in the
    // exclusive transaction, which handles concurrent calls from two hosts.
    await this.broker.claimSpawnBootstrap(lease);
    // Do not catch-and-retry. At this point the provider may have accepted
    // the first turn and an exception/timeout cannot safely distinguish it.
    const bound = await this.transport.start({ task: state.task, agentId: pending.id,
      role: pending.role, brief: pending.brief, executor: role.executor,
      manifestSha256: role.manifestSha256 });
    return this.broker.bindSpawn(lease, bound);
  }
}
