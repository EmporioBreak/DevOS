import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExecutorKind, TaskRef } from "./workflow.js";

/** Owner authorization is verified independently by the host, never by a model. */
export interface DynamicAgentPolicy {
  version: 2;
  task: TaskRef;
  policyId: string;
  maxAgents: number;
  /** Simultaneously executing or waking worker slots; absent uses maxAgents minus owner. */
  maxActiveWorkers?: number;
  maxPendingPerAgent: number;
  /** CoS-inspired bounded journal: never silently drop prior idempotency evidence. */
  maxRecordedMessages?: number;
  /** COS 400k-token revival ceiling; explicitly enabled on verified v2 policies only. */
  workerContextCeilingTokens?: number;
  /** Maximum age of trusted measurement prior to waking a sleeping worker. */
  contextMeasurementMaxAgeMs?: number;
  roles: Record<string, { executor: ExecutorKind; manifestSha256: string; mayAdmit: boolean }>;
}
export interface VerifiedDynamicCaller {
  task: TaskRef;
  agentId: string;
  sessionFingerprint: string;
}
export type DynamicMessageKind = "work" | "question" | "review" | "evidence" | "blocker";
export type DynamicMessageState = "queued" | "tool_offered" | "dispatch_uncertain" | "sent" | "acked";
export type DynamicAgentStatus = "idle" | "busy" | "sleeping" | "waking" | "blocked" | "terminal";
export interface DynamicAgent {
  id: string;
  role: string;
  executor: ExecutorKind | "main_agent";
  manifestSha256: string | null;
  sessionFingerprint: string;
  sessionId?: string;
  status: DynamicAgentStatus;
  lastResult?: string;
  lastFinishKey?: string;
  /** Monotonic host-measured token usage. Never derived from worker prompt. */
  contextTokens?: number;
  contextMeasuredAt?: number;
}
export interface DynamicMessage {
  id: string;
  taskKey: string;
  from: string;
  to: string;
  kind: DynamicMessageKind;
  body: string;
  idempotencyKey: string;
  inReplyTo?: string;
  state: DynamicMessageState;
  providerMessageId?: string;
  /** Verified delivery/ACK boundary; page visibility never proves liveness. */
  providerDeliveredAt?: number;
  /** CoS agent inbox offer metadata, never evidence of a provider Send. */
  toolOffer?: { offeredAt: number; offers: number; offeredOnFinish: boolean };
}
export interface DynamicStatusView {
  task: TaskRef;
  generation: number;
  agents: Array<Pick<DynamicAgent, "id" | "role" | "executor" | "status">>;
  messages: DynamicMessage[];
  finalReviewRequested: boolean;
  ownerDecision?: "approved" | "changes_requested";
}
/** Durable two-phase CoS-style spawn authority; no provisional worker may call tools. */
export interface PendingDynamicSpawn {
  id: string;
  role: string;
  requestedBy: string;
  idempotencyKey: string;
  /** Immutable model-facing task brief, captured in the same durable admission. */
  brief: string;
  /** Once claimed, browser/host bootstrap may have begun and cannot be retried blindly. */
  state: "reserved" | "bootstrap_uncertain" | "bound";
}
export interface DynamicSpawnLease {
  task: TaskRef;
  agentId: string;
  idempotencyKey: string;
}
export interface DynamicSpawnNoStartProof extends DynamicSpawnLease {
  evidenceId: string;
}
export interface DynamicWakeCommand {
  id: string;
  taskKey: string;
  recipientId: string;
  conversationId: string;
  wakeKey: string;
  messageIds: string[];
  state: "queued" | "claimed" | "delivered" | "alive";
  createdAt: number;
  claimedAt?: number;
  deliveredAt?: number;
  providerMessageId?: string;
}
export interface DynamicWakeLease {
  task: TaskRef;
  commandId: string;
  recipientId: string;
  conversationId: string;
  wakeKey: string;
}
export interface DynamicWakeReceipt extends DynamicWakeLease {
  providerMessageId: string;
}
export interface DynamicSnapshot {
  wakeCommands?: DynamicWakeCommand[];
  pendingSpawns?: PendingDynamicSpawn[];
  version: 2;
  task: TaskRef;
  policyHash: string;
  generation: number;
  agents: DynamicAgent[];
  messages: DynamicMessage[];
  finalReviewRequested: boolean;
  ownerDecision?: "approved" | "changes_requested";
}
const SHA256 = /^[a-f0-9]{64}$/;
const IDENT = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_MESSAGE_CHARS = 16000;
function invariant(ok: unknown, description: string): asserts ok {
  if (!ok) throw new Error(description);
}
function taskKey(task: TaskRef): string { return `${task.repo}#${task.issue}`; }
function sameTask(a: TaskRef, b: TaskRef): boolean {
  return a.repo === b.repo && a.issue === b.issue && (a.pr ?? null) === (b.pr ?? null);
}
function policyHash(policy: DynamicAgentPolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
export function validateDynamicPolicy(policy: DynamicAgentPolicy): void {
  invariant(policy.version === 2, "Dynamic policy version must be 2");
  invariant(typeof policy.task.repo === "string" && !!policy.task.repo.trim(), "Invalid task repository");
  invariant(Number.isSafeInteger(policy.task.issue) && policy.task.issue > 0, "Invalid task issue");
  invariant(policy.task.pr === undefined || (Number.isSafeInteger(policy.task.pr) && policy.task.pr > 0), "Invalid task PR");
  invariant(typeof policy.policyId === "string" && SHA256.test(policy.policyId), "Missing sealed policy identifier");
  invariant(Number.isSafeInteger(policy.maxAgents) && policy.maxAgents >= 2 && policy.maxAgents <= 64, "Invalid agent limit");
  invariant(policy.maxActiveWorkers === undefined || (Number.isSafeInteger(policy.maxActiveWorkers) &&
    policy.maxActiveWorkers > 0 && policy.maxActiveWorkers < policy.maxAgents), "Invalid active worker slots");
  invariant(Number.isSafeInteger(policy.maxPendingPerAgent) && policy.maxPendingPerAgent >= 1 && policy.maxPendingPerAgent <= 256, "Invalid inbox limit");
  invariant(policy.maxRecordedMessages === undefined ||
    (Number.isSafeInteger(policy.maxRecordedMessages) && policy.maxRecordedMessages >= 1 &&
      policy.maxRecordedMessages <= 8192), "Invalid message history limit");
  invariant(policy.workerContextCeilingTokens === undefined ||
    (Number.isSafeInteger(policy.workerContextCeilingTokens) &&
      policy.workerContextCeilingTokens >= 1_000 && policy.workerContextCeilingTokens <= 1_000_000),
    "Invalid worker context ceiling");
  invariant(policy.contextMeasurementMaxAgeMs === undefined ||
    (Number.isSafeInteger(policy.contextMeasurementMaxAgeMs) &&
      policy.contextMeasurementMaxAgeMs >= 1_000 && policy.contextMeasurementMaxAgeMs <= 3_600_000),
    "Invalid context measurement freshness");
  invariant(policy.contextMeasurementMaxAgeMs === undefined || policy.workerContextCeilingTokens !== undefined,
    "Context freshness requires a context ceiling");
  invariant(!!policy.roles && typeof policy.roles === "object" && !Array.isArray(policy.roles), "Invalid role catalog");
  invariant(Object.keys(policy.roles).length > 0, "Empty role catalog");
  for (const [role, rule] of Object.entries(policy.roles)) {
    invariant(IDENT.test(role), "Invalid role name");
    invariant(rule.executor === "codex" || rule.executor === "chatgpt_browser", "Invalid role executor");
    invariant(SHA256.test(rule.manifestSha256), "Missing pinned skill manifest");
    invariant(typeof rule.mayAdmit === "boolean", "Invalid admission policy");
  }
}

/**
 * A task-specific, crash-consistent single-writer store.
 * A SIGKILL can leave the .lock behind; it must not be stolen by elapsed-time
 * heuristics. Only independently confirmed writer death permits manual cleanup.
 * v1 .devos/state files and signed legacy graph files remain untouched.
 */
export class DynamicAgentStore {
  readonly path: string;
  constructor(projectRoot: string, task: TaskRef) {
    invariant(typeof projectRoot === "string" && projectRoot.length > 0, "Missing project root");
    invariant(typeof task.repo === "string" && !!task.repo.trim() && Number.isSafeInteger(task.issue) && task.issue > 0, "Invalid task");
    this.path = join(projectRoot, ".devos", "dynamic", `${encodeURIComponent(task.repo)}-issue-${task.issue}.json`);
  }
  async load(): Promise<DynamicSnapshot | null> {
    try { return validateSnapshot(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  }
  async transact<T>(update: (state: DynamicSnapshot | null) => { state: DynamicSnapshot; result: T }): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = await open(`${this.path}.lock`, "wx", 0o600).catch(err => {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("DYNAMIC_STORE_LOCKED: inspect writer before recovery");
      throw err;
    });
    try {
      const before = await this.load();
      const { state, result } = update(before === null ? null : structuredClone(before));
      validateSnapshot(state);
      invariant(state.generation === (before?.generation ?? -1) + 1, "Invalid state generation");
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(`${JSON.stringify(state)}\n`, "utf8"); await file.sync(); }
        finally { await file.close(); }
        await rename(temp, this.path);
        const directory = await open(dirname(this.path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temp, { force: true }); }
      return result;
    } finally { await lock.close(); await rm(`${this.path}.lock`, { force: true }); }
  }
}
function validateSnapshot(state: DynamicSnapshot): DynamicSnapshot {
  invariant(state?.version === 2 && state.task && SHA256.test(state.policyHash), "Invalid dynamic state");
  invariant(Number.isSafeInteger(state.generation) && state.generation >= 0, "Invalid dynamic generation");
  invariant(Array.isArray(state.agents) && Array.isArray(state.messages), "Invalid dynamic collections");
  invariant(state.pendingSpawns === undefined || Array.isArray(state.pendingSpawns), "Invalid spawn ledger");
  invariant(state.wakeCommands === undefined || Array.isArray(state.wakeCommands), "Invalid wake ledger");
  invariant(typeof state.finalReviewRequested === "boolean", "Invalid review state");
  invariant(state.ownerDecision === undefined || state.ownerDecision === "approved" || state.ownerDecision === "changes_requested", "Invalid owner decision");
  const ids = new Set<string>();
  const conversations = new Set<string>();
  const principals = new Set<string>();
  for (const agent of state.agents) {
    invariant(IDENT.test(agent.id) && !ids.has(agent.id), "Duplicate or invalid dynamic agent");
    invariant(typeof agent.sessionFingerprint === "string" && !!agent.sessionFingerprint, "Missing agent proof binding");
    invariant(!principals.has(agent.sessionFingerprint), "Agent principal is claimed by another teammate");
    principals.add(agent.sessionFingerprint);
    if (agent.sessionId !== undefined) {
      invariant(typeof agent.sessionId === "string" && !!agent.sessionId.trim() &&
        !conversations.has(agent.sessionId), "Agent conversation already owned by another teammate");
      conversations.add(agent.sessionId);
    }
    invariant(["idle", "busy", "sleeping", "waking", "blocked", "terminal"].includes(agent.status), "Invalid agent lifecycle state");
    invariant(agent.contextTokens === undefined ||
      (Number.isSafeInteger(agent.contextTokens) && agent.contextTokens >= 0),
      "Invalid context token evidence");
    invariant(agent.contextMeasuredAt === undefined ||
      (Number.isSafeInteger(agent.contextMeasuredAt) && agent.contextMeasuredAt > 0),
      "Invalid context measurement timestamp");
    invariant(agent.lastResult === undefined || (typeof agent.lastResult === "string" &&
      agent.lastResult.length > 0 && agent.lastResult.length <= MAX_MESSAGE_CHARS), "Invalid worker finish");
    invariant(agent.lastFinishKey === undefined || (typeof agent.lastFinishKey === "string" &&
      agent.lastFinishKey.length >= 8 && agent.lastFinishKey.length <= 128), "Invalid worker finish key");
    ids.add(agent.id);
  }
  invariant(ids.has("main_agent"), "Missing Main Agent identity");
  const reserved = new Set<string>(), requests = new Set<string>();
  for (const pending of state.pendingSpawns ?? []) {
    invariant(IDENT.test(pending.id) && !reserved.has(pending.id), "Duplicate spawn reservation");
    invariant(IDENT.test(pending.role) && ids.has(pending.requestedBy), "Invalid reserved spawn identity");
    invariant(typeof pending.brief === "string" && pending.brief.trim().length > 0 &&
      pending.brief.length <= 4_000, "Invalid durable worker bootstrap brief");
    invariant(["reserved", "bootstrap_uncertain", "bound"].includes(pending.state), "Invalid spawn lifecycle");
    invariant(typeof pending.idempotencyKey === "string" && pending.idempotencyKey.length >= 8 &&
      pending.idempotencyKey.length <= 128, "Invalid spawn idempotency key");
    const requestKey = pending.requestedBy + "\\u0000" + pending.idempotencyKey;
    invariant(!requests.has(requestKey), "Duplicate spawn request identity");
    invariant(pending.state === "bound" ? ids.has(pending.id) : !ids.has(pending.id),
      "Spawn reservation conflicts with published worker");
    reserved.add(pending.id); requests.add(requestKey);
  }
  const msgIds = new Set<string>();
  const dedupe = new Set<string>();
  for (const msg of state.messages) {
    invariant(typeof msg.id === "string" && !msgIds.has(msg.id), "Duplicate message identity");
    invariant(msg.taskKey === taskKey(state.task) && ids.has(msg.from) && ids.has(msg.to), "Cross-task or unknown message identity");
    invariant(["queued", "tool_offered", "dispatch_uncertain", "sent", "acked"].includes(msg.state), "Invalid delivery state");
    invariant(msg.providerDeliveredAt === undefined ||
      (Number.isSafeInteger(msg.providerDeliveredAt) && msg.providerDeliveredAt > 0),
      "Invalid provider acceptance time");
    if (msg.state === "tool_offered") {
      invariant(msg.toolOffer && Number.isSafeInteger(msg.toolOffer.offeredAt) &&
        msg.toolOffer.offeredAt > 0 && Number.isSafeInteger(msg.toolOffer.offers) &&
        msg.toolOffer.offers > 0 && typeof msg.toolOffer.offeredOnFinish === "boolean", "Invalid tool offer");
    }
    invariant(msg.body.length > 0 && msg.body.length <= MAX_MESSAGE_CHARS, "Invalid message length");
    const key = `${msg.from}\u0000${msg.idempotencyKey}`;
    invariant(!dedupe.has(key), "Duplicate idempotency identity");
    msgIds.add(msg.id); dedupe.add(key);
  }
  const wakeIds = new Set<string>(), wakeKeys = new Set<string>();
  for (const command of state.wakeCommands ?? []) {
    invariant(typeof command.id === "string" && !wakeIds.has(command.id), "Duplicate wake command");
    invariant(command.taskKey === taskKey(state.task) && ids.has(command.recipientId) &&
      command.recipientId !== "main_agent", "Invalid wake recipient");
    const recipient = state.agents.find(a => a.id === command.recipientId)!;
    invariant(recipient.sessionId === command.conversationId, "Wake lost exact saved conversation");
    invariant(SHA256.test(command.wakeKey) && !wakeKeys.has(command.wakeKey), "Duplicate wake identity");
    invariant(["queued","claimed","delivered","alive"].includes(command.state), "Invalid wake state");
    invariant(Number.isSafeInteger(command.createdAt) && command.createdAt > 0, "Invalid wake timestamp");
    invariant(Array.isArray(command.messageIds) && command.messageIds.length > 0 &&
      new Set(command.messageIds).size === command.messageIds.length &&
      command.messageIds.every(id => state.messages.some(m => m.id === id && m.to === command.recipientId)),
      "Wake refers to missing/foreign messages");
    invariant(command.wakeKey === createHash("sha256").update(command.messageIds.join("\0")).digest("hex"),
      "Wake message identity changed");
    invariant(command.state === "queued" ||
      (Number.isSafeInteger(command.claimedAt) && command.claimedAt! > 0), "Wake claim not durable");
    invariant(!["delivered","alive"].includes(command.state) ||
      (!!command.providerMessageId && Number.isSafeInteger(command.deliveredAt) && command.deliveredAt! > 0),
      "Wake provider acceptance not durable");
    if (command.state !== "alive") invariant(recipient.status === "waking" ||
      recipient.status === "blocked", "Unresolved wake recipient not waking");
    wakeIds.add(command.id); wakeKeys.add(command.wakeKey);
  }
  return state;
}
export interface VerifiedDynamicToolCall {
  task: TaskRef;
  recipientId: string;
  callId: string;
  startedAt: number;
  byFinish?: boolean;
}
export interface DynamicDeliveryReceipt {
  task: TaskRef;
  messageId: string;
  providerMessageId: string;
}
export interface DynamicTransportLease {
  task: TaskRef;
  messageId: string;
  recipientId: string;
}
export interface DynamicNoSubmitProof {
  task: TaskRef;
  messageId: string;
  evidenceId: string;
}
/** Callbacks must use authenticated host evidence, never prompt or user-entered IDs. */
export interface DynamicTrustBoundary {
  resolveCaller(): Promise<VerifiedDynamicCaller>;
  verifyPolicy(policy: DynamicAgentPolicy): Promise<boolean>;
  verifyNewAgentBinding(binding: { task: TaskRef; id: string; role: string; sessionFingerprint: string;
    sessionId?: string }): Promise<boolean>;
  verifyTransportLease(lease: DynamicTransportLease): Promise<boolean>;
  /** Prove a later, exact MCP call belongs to the already bound recipient. */
  verifyToolCall(call: VerifiedDynamicToolCall): Promise<boolean>;
  /** Host-owned, exact reserved agent bootstrap identity. Absent = default deny. */
  verifySpawnLease?(lease: DynamicSpawnLease): Promise<boolean>;
  verifySpawnNoStart?(proof: DynamicSpawnNoStartProof): Promise<boolean>;
  /** Independent code/QA/security evidence verified by host, not by worker's prompt. */
  verifyIndependentReview?(input: { task: TaskRef; requesterId: string;
    sessionFingerprint: string }): Promise<boolean>;
  verifyWakeLease?(lease: DynamicWakeLease): Promise<boolean>;
  verifyWakeReceipt?(receipt: DynamicWakeReceipt): Promise<boolean>;
  verifyContextMeasurement?(input: { task: TaskRef; agentId: string; sessionId: string;
    sessionFingerprint: string; tokens: number; evidenceId: string }): Promise<boolean>;
  verifyProviderReceipt(receipt: DynamicDeliveryReceipt): Promise<boolean>;
  verifyNoSubmit(proof: DynamicNoSubmitProof): Promise<boolean>;
}
export class DynamicAgentBroker {
  constructor(
    private readonly policy: DynamicAgentPolicy,
    private readonly store: DynamicAgentStore,
    private readonly trust: DynamicTrustBoundary,
  ) { validateDynamicPolicy(policy); }

  async initialize(): Promise<DynamicSnapshot> {
    invariant(await this.trust.verifyPolicy(this.policy), "Unapproved dynamic task policy");
    const caller = await this.trust.resolveCaller();
    invariant(sameTask(caller.task, this.policy.task) && caller.agentId === "main_agent" && !!caller.sessionFingerprint, "Authenticated Main Agent required");
    return this.store.transact(existing => {
      invariant(!existing, "Dynamic task already initialized");
      const state: DynamicSnapshot = {
        version: 2, task: this.policy.task, policyHash: policyHash(this.policy), generation: 0,
        agents: [{ id: "main_agent", role: "main_agent", executor: "main_agent", manifestSha256: null,
          sessionFingerprint: caller.sessionFingerprint, status: "idle" }],
        messages: [], pendingSpawns: [], wakeCommands: [], finalReviewRequested: false,
      };
      return { state, result: state };
    });
  }
  private checked(state: DynamicSnapshot, caller: VerifiedDynamicCaller): DynamicAgent {
    invariant(sameTask(state.task, this.policy.task) && state.policyHash === policyHash(this.policy), "Task/policy binding changed");
    invariant(sameTask(caller.task, state.task), "Cross-task caller denied");
    const actor = state.agents.find(a => a.id === caller.agentId);
    invariant(actor && actor.sessionFingerprint === caller.sessionFingerprint, "Unverified agent/session identity");
    return actor;
  }
  private async perform<T>(fn: (s: DynamicSnapshot, actor: DynamicAgent) => T): Promise<T> {
    invariant(await this.trust.verifyPolicy(this.policy), "Unapproved dynamic task policy");
    const caller = await this.trust.resolveCaller();
    return this.store.transact(existing => {
      invariant(existing, "Dynamic task not initialized");
      const actor = this.checked(existing, caller);
      invariant(existing.ownerDecision !== "approved", "Task already accepted");
      const result = fn(existing, actor);
      existing.generation++;
      return { state: existing, result };
    });
  }
  /** Public caller-visible status does not disclose peer sessions or unrelated messages. */
  async status(): Promise<DynamicStatusView> {
    invariant(await this.trust.verifyPolicy(this.policy), "Unapproved dynamic task policy");
    const caller = await this.trust.resolveCaller();
    const state = await this.store.load();
    invariant(state, "Dynamic task not initialized");
    const actor = this.checked(state, caller);
    return {
      task: state.task,
      generation: state.generation,
      agents: state.agents.map(({ id, role, executor, status }) => ({ id, role, executor, status })),
      messages: state.messages.filter(m => actor.id === "main_agent" || m.from === actor.id || m.to === actor.id),
      finalReviewRequested: state.finalReviewRequested,
      ...(state.ownerDecision ? { ownerDecision: state.ownerDecision } : {}),
    };
  }

  /**
   * CoS stageSpawn() adapted to dynamic peer admission: reserve host-owned
   * identity *before* creating a browser tab or Codex session. The reservation
   * is durably published, but remains unreachable to worker calls until host
   * proves the real new session in bindSpawn().
   */
  async requestSpawn(input: { id: string; role: string; idempotencyKey: string; brief: string }): Promise<PendingDynamicSpawn> {
    return (await this.requestSpawnBatch([input]))[0]!;
  }
  /**
   * CoS spawn() batch admission: validate the entire requested team and
   * reserve every slot atomically; no partial worker bootstraps if a later
   * requested capability, identity, idempotency key or quota is rejected.
   * Browser/host creation happens later and separately for each accepted
   * reservation using claimSpawnBootstrap().
   */
  async requestSpawnBatch(inputs: ReadonlyArray<{
    id: string; role: string; idempotencyKey: string; brief: string
  }>): Promise<PendingDynamicSpawn[]> {
    invariant(Array.isArray(inputs) && inputs.length >= 1 && inputs.length <= 8,
      "Spawn batch size must be 1..8");
    return this.perform((state, actor) => {
      invariant(actor.status !== "sleeping" && actor.status !== "waking" &&
        actor.status !== "blocked" && actor.status !== "terminal",
        "Inactive worker cannot admit specialists");
      invariant(actor.id === "main_agent" || this.policy.roles[actor.role]?.mayAdmit,
        "Actor cannot admit specialists");
      const accepted = state.pendingSpawns ??= [];
      const additions: PendingDynamicSpawn[] = [];
      const results: PendingDynamicSpawn[] = [];
      for (const input of inputs) {
        invariant(IDENT.test(input.id) && input.id !== "main_agent" && IDENT.test(input.role),
          "Invalid requested agent identity");
        invariant(typeof input.idempotencyKey === "string" &&
          input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128,
          "Invalid spawn idempotency key");
        invariant(typeof input.brief === "string" && input.brief.trim().length > 0 &&
          input.brief.length <= 4_000, "Invalid worker bootstrap brief");
        const existing = [...accepted, ...additions].find(p =>
          p.requestedBy === actor.id && p.idempotencyKey === input.idempotencyKey);
        if (existing) {
          invariant(existing.id === input.id && existing.role === input.role &&
            existing.brief === input.brief, "Spawn idempotency-key conflict");
          results.push(existing);
          continue;
        }
        invariant(!state.agents.some(a => a.id === input.id) &&
          !accepted.some(p => p.id === input.id) && !additions.some(p => p.id === input.id),
          "Agent identity already owned or reserved");
        invariant(this.policy.roles[input.role], "Role/capability outside task policy");
        const entry: PendingDynamicSpawn = {
          id: input.id, role: input.role, idempotencyKey: input.idempotencyKey,
          requestedBy: actor.id, brief: input.brief, state: "reserved"
        };
        additions.push(entry);
        results.push(entry);
      }
      const unbound = accepted.filter(p => p.state !== "bound").length;
      const active = state.agents.filter(a => a.id !== "main_agent" &&
        ["busy", "waking"].includes(a.status)).length;
      invariant(state.agents.length + unbound + additions.length <= this.policy.maxAgents,
        "Agent budget exhausted");
      invariant(active + unbound + additions.length <=
        (this.policy.maxActiveWorkers ?? this.policy.maxAgents - 1),
        "NO_FREE_SLOT: worker bootstrap capacity exhausted");
      accepted.push(...additions);
      return results;
    });
  }
  /**
   * Browser/bootstrap authority belongs to a *verified host lease*, not to a
   * worker model or arbitrary recipient fingerprint. Fence before side effects.
   */
  async claimSpawnBootstrap(lease: DynamicSpawnLease): Promise<PendingDynamicSpawn> {
    invariant(sameTask(lease.task, this.policy.task), "Cross-task spawn denied");
    invariant(await this.trust.verifyPolicy(this.policy) &&
      await this.trust.verifySpawnLease?.(lease) === true, "Unverified spawn bootstrap lease");
    return this.store.transact(existing => {
      invariant(existing && existing.policyHash === policyHash(this.policy) &&
        sameTask(existing.task, this.policy.task) && existing.ownerDecision !== "approved",
        "Spawn task policy changed");
      const pending = existing.pendingSpawns?.find(p => p.id === lease.agentId &&
        p.idempotencyKey === lease.idempotencyKey);
      invariant(pending && pending.state === "reserved", "Spawn bootstrap already claimed or bound");
      pending.state = "bootstrap_uncertain";
      existing.generation++;
      return { state: existing, result: pending };
    });
  }
  /**
   * Host confirms an actual saved provider conversation / Codex session after
   * an already claimed bootstrap. A retry with exact same binding is safe.
   */
  async bindSpawn(lease: DynamicSpawnLease, binding: {
    sessionId: string; sessionFingerprint: string
  }): Promise<DynamicAgent> {
    invariant(sameTask(lease.task, this.policy.task) &&
      typeof binding.sessionId === "string" && !!binding.sessionId.trim() &&
      typeof binding.sessionFingerprint === "string" && !!binding.sessionFingerprint.trim(),
      "Invalid spawn provider identity");
    invariant(await this.trust.verifyPolicy(this.policy) &&
      await this.trust.verifySpawnLease?.(lease) === true &&
      await this.trust.verifyNewAgentBinding({
        task: this.policy.task, id: lease.agentId,
        role: (await this.store.load())?.pendingSpawns?.find(p => p.id === lease.agentId &&
          p.idempotencyKey === lease.idempotencyKey)?.role ?? "",
        sessionFingerprint: binding.sessionFingerprint, sessionId: binding.sessionId,
      }), "Unverified spawned provider identity");
    return this.store.transact(existing => {
      invariant(existing && existing.policyHash === policyHash(this.policy) &&
        sameTask(existing.task, this.policy.task) && existing.ownerDecision !== "approved",
        "Spawn task policy changed");
      const pending = existing.pendingSpawns?.find(p => p.id === lease.agentId &&
        p.idempotencyKey === lease.idempotencyKey);
      invariant(pending && (pending.state === "bootstrap_uncertain" || pending.state === "bound"),
        "Bootstrap must be claimed before session binding");
      const admitted = existing.agents.find(a => a.id === lease.agentId);
      if (pending.state === "bound") {
        invariant(admitted && admitted.sessionId === binding.sessionId &&
          admitted.sessionFingerprint === binding.sessionFingerprint,
          "Spawn binding conflict");
        existing.generation++;
        return { state: existing, result: admitted };
      }
      invariant(!admitted, "Spawn identity already bound");
      const rule = this.policy.roles[pending.role];
      invariant(rule, "Spawn capability revoked");
      const agent: DynamicAgent = { id: pending.id, role: pending.role,
        executor: rule.executor, manifestSha256: rule.manifestSha256,
        sessionId: binding.sessionId, sessionFingerprint: binding.sessionFingerprint,
        status: "idle" };
      existing.agents.push(agent);
      pending.state = "bound";
      existing.generation++;
      return { state: existing, result: agent };
    });
  }
  /** A failed pre-submit bootstrap may be released only with host-only proof. */
  async releaseUnstartedSpawn(proof: DynamicSpawnNoStartProof): Promise<PendingDynamicSpawn> {
    invariant(sameTask(proof.task, this.policy.task) && !!proof.evidenceId?.trim() &&
      await this.trust.verifySpawnNoStart?.(proof) === true &&
      await this.trust.verifySpawnLease?.(proof) === true &&
      await this.trust.verifyPolicy(this.policy), "Missing independent no-bootstrap proof");
    return this.store.transact(existing => {
      invariant(existing && existing.policyHash === policyHash(this.policy) &&
        sameTask(existing.task, this.policy.task), "Spawn policy changed");
      const pending = existing.pendingSpawns?.find(p => p.id === proof.agentId &&
        p.idempotencyKey === proof.idempotencyKey);
      invariant(pending && pending.state === "bootstrap_uncertain", "No uncertain spawn to release");
      pending.state = "reserved";
      existing.generation++;
      return { state: existing, result: pending };
    });
  }

  async admit(input: { id: string; role: string; sessionFingerprint: string }): Promise<DynamicAgent> {
    invariant(await this.trust.verifyNewAgentBinding({ ...input, task: this.policy.task }), "Unverified new agent identity");
    return this.perform((state, actor) => {
      invariant(actor.status !== "sleeping" && actor.status !== "waking" &&
        actor.status !== "blocked" && actor.status !== "terminal",
        "Inactive worker cannot admit specialists");
      invariant(actor.id === "main_agent" || this.policy.roles[actor.role]?.mayAdmit, "Actor cannot admit specialists");
      invariant(IDENT.test(input.id) && input.id !== "main_agent" && !state.agents.some(a => a.id === input.id), "Invalid or duplicate agent id");
      invariant(!!input.sessionFingerprint && typeof input.sessionFingerprint === "string", "No verified session binding");
      invariant(state.agents.length < this.policy.maxAgents, "Agent budget exhausted");
      const role = this.policy.roles[input.role];
      invariant(role, "Role/capability outside task policy");
      const admitted: DynamicAgent = { id: input.id, role: input.role, executor: role.executor,
        manifestSha256: role.manifestSha256, sessionFingerprint: input.sessionFingerprint, status: "idle" };
      state.agents.push(admitted);
      return admitted;
    });
  }
  async bindSession(sessionId: string): Promise<void> {
    await this.perform((_state, actor) => {
      invariant(typeof sessionId === "string" && !!sessionId.trim(), "Empty session binding");
      invariant(!actor.sessionId || actor.sessionId === sessionId, "Cannot replace saved agent conversation");
      actor.sessionId = sessionId;
    });
  }
  /**
   * Port of CoS agents.ts stageMessagesActive() planning:
   * validate the *entire* batch and per-recipient capacities before accepting
   * any messages. Our per-Issue store clones and durably commits the snapshot
   * as one transaction instead of CoS's in-memory staged/publication overlay.
   * Source: CoS f64ee51, src/main/agents.ts stageMessagesActive.
   */
  async sendBatch(items: ReadonlyArray<{ to: string; kind: DynamicMessageKind; body: string;
    idempotencyKey: string; inReplyTo?: string }>): Promise<DynamicMessage[]> {
    invariant(Array.isArray(items) && items.length > 0 && items.length <= 16, "Message batch size must be 1..16");
    return this.perform((state, actor) => {
      invariant(actor.status !== "blocked" && actor.status !== "sleeping" &&
        actor.status !== "waking" && actor.status !== "terminal", "Sender is not executing work");
      const planned: DynamicMessage[] = [];
      const waking = new Set<string>();
      const byRecipient = new Map<string, number>();
      const byKey = new Map<string, DynamicMessage>();
      for (const input of items) {
        invariant(["work", "question", "review", "evidence", "blocker"].includes(input.kind), "Unknown message kind");
        invariant(typeof input.body === "string" && input.body.trim().length > 0 &&
          input.body.length <= MAX_MESSAGE_CHARS, "Invalid message body");
        invariant(typeof input.idempotencyKey === "string" &&
          input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128, "Invalid idempotency key");
        const recipient = state.agents.find(a => a.id === input.to);
        invariant(input.to !== actor.id && recipient, "Unknown recipient or self-send");
        invariant(!input.inReplyTo || [...state.messages, ...planned].some(m =>
          m.id === input.inReplyTo && (m.to === actor.id || m.from === actor.id)), "Invalid reply chain");
        const existing = byKey.get(input.idempotencyKey) ??
          state.messages.find(m => m.from === actor.id && m.idempotencyKey === input.idempotencyKey);
        if (existing) {
          invariant(existing.to === input.to && existing.kind === input.kind && existing.body === input.body &&
            existing.inReplyTo === input.inReplyTo, "Idempotency-key payload conflict");
          byKey.set(input.idempotencyKey, existing);
          planned.push(existing);
          continue;
        }
        // CoS beginRevival(): queue ownership and active-slot reservation are
        // one transaction; a wake already in progress refuses further work.
        invariant(recipient.status !== "waking" && recipient.status !== "blocked" &&
          recipient.status !== "terminal", "Recipient cannot accept another wake");
        if (recipient.status === "sleeping") {
          invariant(!!recipient.sessionId, "Sleeping worker has no original conversation to wake");
          if (this.policy.workerContextCeilingTokens !== undefined) {
            invariant(recipient.contextTokens !== undefined &&
              recipient.contextMeasuredAt !== undefined &&
              Date.now() - recipient.contextMeasuredAt >= 0 &&
              Date.now() - recipient.contextMeasuredAt <=
                (this.policy.contextMeasurementMaxAgeMs ?? 30_000),
              "WORKER_CONTEXT_UNVERIFIED: fresh host measurement required before revival");
            invariant(recipient.contextTokens < this.policy.workerContextCeilingTokens,
              "WORKER_CONTEXT_LIMITED: conversation cannot be revived");
          }
          waking.add(recipient.id);
        }
        const already = byRecipient.get(input.to) ?? 0;
        invariant(state.messages.filter(m => m.to === input.to && m.state !== "acked").length +
          already < this.policy.maxPendingPerAgent, "Inbox budget exhausted");
        const msg: DynamicMessage = { id: randomUUID(), taskKey: taskKey(state.task), from: actor.id,
          to: input.to, kind: input.kind, body: input.body, idempotencyKey: input.idempotencyKey,
          ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}), state: "queued" };
        byRecipient.set(input.to, already + 1);
        byKey.set(input.idempotencyKey, msg);
        planned.push(msg);
      }
      const active = state.agents.filter(a =>
        a.id !== "main_agent" && (a.status === "busy" || a.status === "waking")).length;
      invariant(active + waking.size <= (this.policy.maxActiveWorkers ?? this.policy.maxAgents - 1),
        "NO_FREE_SLOT: sleeping worker cannot be woken");
      for (const agent of state.agents) if (waking.has(agent.id)) agent.status = "waking";
      // This synchronous, single-writer projection is published *only* when
      // DynamicAgentStore.transact() has fsynced and renamed the accepted snapshot.
      const additions = planned.filter(m => !state.messages.includes(m)).filter((m,i,a)=>a.indexOf(m)===i);
      invariant(state.messages.length + additions.length <= (this.policy.maxRecordedMessages ?? 8192),
        "Message history limit reached; refusing unprovable idempotency eviction");
      state.messages.push(...additions);
      // CoS beginRevival + bridge CommandSpec(revive): wake and message set
      // share the same disk commit; no browser side effects until host claim.
      for (const recipientId of waking) {
        const agent = state.agents.find(a => a.id === recipientId)!;
        const messageIds = state.messages.filter(m => m.to === recipientId && m.state === "queued").map(m => m.id);
        invariant(messageIds.length > 0, "Cannot wake without pending messages");
        const wakeKey = createHash("sha256").update(messageIds.join("\0")).digest("hex");
        invariant(!(state.wakeCommands ?? []).some(c => c.wakeKey === wakeKey), "Duplicate wake identity");
        (state.wakeCommands ??= []).push({
          id: randomUUID(), taskKey: taskKey(state.task), recipientId,
          conversationId: agent.sessionId!, wakeKey, messageIds, state: "queued",
          createdAt: Date.now()
        });
      }
      return planned;
    });
  }
  async send(input: { to: string; kind: DynamicMessageKind; body: string;
    idempotencyKey: string; inReplyTo?: string }): Promise<DynamicMessage> {
    return (await this.sendBatch([input]))[0]!;
  }

  /**
   * Port of CoS offerAgentMessages(): deliver queued work through the next
   * authenticated MCP tool result without opening a *second* ChatGPT user turn.
   * Offered rows are at-least-once; re-offer on lost tool results is intentional.
   * Never combine browser-send custody and tool-result delivery.
   */
  async offerToolInbox(maxChars = 32_000, byFinish = false): Promise<DynamicMessage[]> {
    invariant(Number.isSafeInteger(maxChars) && maxChars > 0 && maxChars <= 32_000, "Invalid offer byte budget");
    return this.perform((state, actor) => {
      invariant(actor.status !== "blocked" && actor.status !== "sleeping" &&
        actor.status !== "waking" && actor.status !== "terminal" &&
        !!actor.sessionId, "No active bound agent session for tool offer");
      const pending = state.messages.filter(m => m.to === actor.id && m.state !== "acked");
      const offered: DynamicMessage[] = [];
      let size = 0;
      for (const msg of pending) {
        // A browser Send might already have reached ChatGPT: never duplicate it in a tool result.
        if (msg.state === "sent" || msg.state === "dispatch_uncertain") break;
        if (msg.state !== "queued" && msg.state !== "tool_offered") break;
        if (offered.length && size + msg.body.length > maxChars) break;
        if (!offered.length && msg.body.length > maxChars) break;
        size += msg.body.length;
        const old = msg.toolOffer;
        msg.state = "tool_offered";
        msg.toolOffer = { offeredAt: Date.now(), offers: (old?.offers ?? 0) + 1, offeredOnFinish: byFinish };
        offered.push(msg);
      }
      return offered;
    });
  }
  /**
   * Port of CoS acknowledgeAgentOffers(): caller identity AND a subsequent
   * trusted MCP call whose start strictly follows the latest offer are needed.
   * A finish retry must not acknowledge its *own* lost finish-result offer.
   */
  async acknowledgeToolInbox(call: VerifiedDynamicToolCall): Promise<string[]> {
    invariant(sameTask(call.task, this.policy.task) && typeof call.callId === "string" &&
      !!call.callId.trim() && Number.isSafeInteger(call.startedAt) && call.startedAt > 0,
      "Invalid tool call receipt");
    invariant(await this.trust.verifyToolCall(call), "Unverified subsequent tool call");
    return this.perform((state, actor) => {
      invariant(actor.id === call.recipientId && !!actor.sessionId, "Tool call recipient mismatch");
      // The verified MCP call may ACK tool offers, but cannot by itself
      // prove a specific browser wake was delivered; noteAgentAlive owns that.
      const acknowledged: string[] = [];
      for (const msg of state.messages) {
        if (msg.to !== actor.id || msg.state !== "tool_offered" || !msg.toolOffer) continue;
        if (msg.toolOffer.offeredAt >= call.startedAt || (call.byFinish && msg.toolOffer.offeredOnFinish)) continue;
        msg.state = "acked";
        acknowledged.push(msg.id);
      }
      return acknowledged;
    });
  }

  /** CoS bridge: a claimed wake is permanently uncertain until provider proof. */
  private async hostWake<T>(lease: DynamicWakeLease, fn: (command: DynamicWakeCommand,
    state: DynamicSnapshot) => T): Promise<T> {
    invariant(sameTask(lease.task, this.policy.task), "Cross-task wake denied");
    invariant(await this.trust.verifyPolicy(this.policy) &&
      await this.trust.verifyWakeLease?.(lease) === true, "Unverified wake lease");
    return this.store.transact(existing => {
      invariant(existing && existing.policyHash === policyHash(this.policy) &&
        sameTask(existing.task, this.policy.task) && existing.ownerDecision !== "approved",
        "Wake policy or task changed");
      const command = existing.wakeCommands?.find(c => c.id === lease.commandId &&
        c.recipientId === lease.recipientId && c.conversationId === lease.conversationId &&
        c.wakeKey === lease.wakeKey);
      invariant(command, "Wake command/exact chat identity mismatch");
      invariant(existing.agents.find(a => a.id === lease.recipientId)?.status === "waking",
        "Wake recipient is not in waking state");
      const result = fn(command, existing);
      existing.generation++;
      return { state: existing, result };
    });
  }
  async claimWake(lease: DynamicWakeLease): Promise<DynamicWakeCommand> {
    return this.hostWake(lease, (command, state) => {
      invariant(command.state === "queued", "Wake may already have reached provider; do not retry");
      invariant(command.messageIds.every(id => state.messages.some(m => m.id === id && m.state === "queued")),
        "Wake message set already handled");
      command.state = "claimed";
      command.claimedAt = Date.now();
      return command;
    });
  }
  async confirmWake(lease: DynamicWakeLease, receipt: DynamicWakeReceipt): Promise<DynamicWakeCommand> {
    invariant(sameTask(receipt.task, lease.task) && receipt.commandId === lease.commandId &&
      receipt.recipientId === lease.recipientId && receipt.conversationId === lease.conversationId &&
      receipt.wakeKey === lease.wakeKey && !!receipt.providerMessageId?.trim(),
      "Wake receipt/caller mismatch");
    invariant(await this.trust.verifyWakeReceipt?.(receipt) === true, "Unverified provider wake receipt");
    return this.hostWake(lease, (command, state) => {
      invariant(command.state === "claimed" || (command.state === "delivered" &&
        command.providerMessageId === receipt.providerMessageId), "Wake not claimable for receipt");
      invariant(!state.messages.some(m => m.to === lease.recipientId &&
        !command.messageIds.includes(m.id) && m.providerMessageId === receipt.providerMessageId),
        "Provider message identity already attributed");
      invariant(command.messageIds.every(id => state.messages.some(m => m.id === id &&
        (m.state === "queued" || m.providerMessageId === receipt.providerMessageId))),
        "Wake message ownership conflict");
      if (command.state === "claimed") {
        const when = Date.now();
        command.deliveredAt = when;
        for (const msg of state.messages) if (command.messageIds.includes(msg.id)) {
          msg.state = "sent"; msg.providerMessageId = receipt.providerMessageId;
          msg.providerDeliveredAt = when;
        }
      }
      command.providerMessageId = receipt.providerMessageId;
      command.state = "delivered";
      return command;
    });
  }

  /** Commit the uncertain dispatch fence before touching ChatGPT/Codex. */
  async claimForDelivery(messageId: string): Promise<DynamicMessage> {
    return this.perform((state, actor) => {
      const msg = state.messages.find(m => m.id === messageId && m.to === actor.id);
      invariant(actor.status !== "sleeping" && actor.status !== "waking",
        "Stopped worker requires exact wake command before a new Send");
      invariant(msg && msg.state === "queued", "Message not claimable; may already have been submitted");
      invariant(!state.wakeCommands?.some(c => c.state !== "alive" && c.messageIds.includes(msg.id)),
        "Wake-owned work must use exact revival command");
      invariant(state.messages.find(m => m.to === msg.to && m.state !== "acked") === msg, "Recipient queue order violation");
      msg.state = "dispatch_uncertain";
      return msg;
    });
  }
  /** Transport can wake the recipient without impersonating its model conversation. */
  private async hostDelivery<T>(lease: DynamicTransportLease, fn: (msg: DynamicMessage, state: DynamicSnapshot) => T): Promise<T> {
    invariant(sameTask(lease.task, this.policy.task), "Cross-task transport denied");
    invariant(await this.trust.verifyPolicy(this.policy), "Unapproved dynamic task policy");
    invariant(await this.trust.verifyTransportLease(lease), "Unverified transport authority");
    return this.store.transact(existing => {
      invariant(existing && sameTask(existing.task, this.policy.task) && existing.policyHash === policyHash(this.policy), "Task/policy binding changed");
      invariant(existing.ownerDecision !== "approved", "Task already accepted");
      const msg = existing.messages.find(m => m.id === lease.messageId && m.to === lease.recipientId);
      invariant(msg, "Transport recipient/message mismatch");
      const result = fn(msg, existing);
      existing.generation++;
      return { state: existing, result };
    });
  }
  async claimForTransport(lease: DynamicTransportLease): Promise<DynamicMessage> {
    return this.hostDelivery(lease, (msg, state) => {
      const recipient = state.agents.find(a => a.id === msg.to);
      invariant(recipient && recipient.status !== "sleeping" && recipient.status !== "waking",
        "Stopped worker requires exact wake command before a new Send");
      invariant(msg.state === "queued", "Message not claimable; may already have been submitted");
      invariant(!state.wakeCommands?.some(c => c.state !== "alive" && c.messageIds.includes(msg.id)),
        "Wake-owned work must use exact revival command");
      invariant(state.messages.find(m => m.to === msg.to && m.state !== "acked") === msg, "Recipient queue order violation");
      msg.state = "dispatch_uncertain";
      return msg;
    });
  }
  async confirmTransportDelivery(lease: DynamicTransportLease, receipt: DynamicDeliveryReceipt): Promise<DynamicMessage> {
    invariant(receipt.messageId === lease.messageId && sameTask(receipt.task, lease.task) && !!receipt.providerMessageId?.trim(), "Transport receipt identity mismatch");
    invariant(await this.trust.verifyProviderReceipt(receipt), "Unverified provider receipt");
    return this.hostDelivery(lease, (msg, state) => {
      invariant(msg.state === "dispatch_uncertain" || (msg.state === "sent" && msg.providerMessageId === receipt.providerMessageId), "Delivery not claimable");
      invariant(!state.messages.some(m => m.id !== msg.id && m.to === msg.to && m.providerMessageId === receipt.providerMessageId), "Provider receipt already attributed");
      if (!msg.providerDeliveredAt) msg.providerDeliveredAt = Date.now();
      msg.state = "sent"; msg.providerMessageId = receipt.providerMessageId;
      return msg;
    });
  }
  async releaseTransportNoSubmit(lease: DynamicTransportLease, proof: DynamicNoSubmitProof): Promise<void> {
    invariant(proof.messageId === lease.messageId && sameTask(proof.task, lease.task) && !!proof.evidenceId?.trim(), "Pre-submit proof mismatch");
    invariant(await this.trust.verifyNoSubmit(proof), "Missing independent no-submit evidence");
    await this.hostDelivery(lease, msg => {
      invariant(msg.state === "dispatch_uncertain", "No uncertain dispatch to release");
      msg.state = "queued";
    });
  }
  async confirmDelivery(receipt: DynamicDeliveryReceipt): Promise<DynamicMessage> {
    invariant(sameTask(receipt.task, this.policy.task) && !!receipt.providerMessageId?.trim(), "Invalid delivery receipt");
    invariant(await this.trust.verifyProviderReceipt(receipt), "Unverified provider receipt");
    return this.perform((state, actor) => {
      const msg = state.messages.find(m => m.id === receipt.messageId && m.to === actor.id);
      invariant(msg && (msg.state === "dispatch_uncertain" || (msg.state === "sent" && msg.providerMessageId === receipt.providerMessageId)), "Delivery not claimable");
      invariant(!state.messages.some(m => m.id !== msg.id && m.to === msg.to && m.providerMessageId === receipt.providerMessageId), "Provider receipt already attributed");
      msg.state = "sent"; msg.providerMessageId = receipt.providerMessageId;
      return msg;
    });
  }
  async acknowledge(messageId: string): Promise<void> {
    await this.perform((state, actor) => {
      const msg = state.messages.find(m => m.id === messageId && m.to === actor.id);
      invariant(msg && (msg.state === "sent" || msg.state === "acked"), "Provider delivery not confirmed");
      msg.state = "acked";
      // CoS noteAgentAlive(): the browser Send ACK is not evidence the model
      // is responding. A later authenticated call must revive this worker.
    });
  }
  async releaseProvenUnsubmitted(proof: DynamicNoSubmitProof): Promise<void> {
    invariant(sameTask(proof.task, this.policy.task) && !!proof.evidenceId?.trim(), "Invalid pre-submit proof");
    invariant(await this.trust.verifyNoSubmit(proof), "Missing independent no-submit evidence");
    await this.perform((state, actor) => {
      const msg = state.messages.find(m => m.id === proof.messageId && m.to === actor.id);
      invariant(msg && msg.state === "dispatch_uncertain", "No uncertain dispatch to release");
      msg.state = "queued";
    });
  }
  /**
   * COS noteAgentContextTokens(): persist monotonic trusted host observations.
   * A running worker is allowed to finish its current turn after crossing the
   * ceiling, but cannot be revived after that finish. A parked worker becomes
   * terminal immediately, preserving its exact conversation as a denial fence.
   */
  async noteContextTokens(input: { task: TaskRef; agentId: string;
    sessionId: string; sessionFingerprint: string; tokens: number;
    evidenceId: string }): Promise<{ contextTokens: number; status: DynamicAgentStatus }> {
    invariant(sameTask(input.task, this.policy.task) && typeof input.agentId === "string" &&
      typeof input.sessionId === "string" && !!input.sessionId &&
      Number.isSafeInteger(input.tokens) && input.tokens >= 0 &&
      typeof input.evidenceId === "string" && !!input.evidenceId.trim(),
      "Invalid independent context measurement");
    invariant(await this.trust.verifyPolicy(this.policy) &&
      await this.trust.verifyContextMeasurement?.(input) === true,
      "Unverified context measurement");
    return this.store.transact(existing => {
      invariant(existing && existing.policyHash === policyHash(this.policy) &&
        sameTask(existing.task, input.task), "Context measurement task/policy changed");
      const agent = existing.agents.find(a => a.id === input.agentId);
      invariant(agent && agent.id !== "main_agent" &&
        agent.sessionId === input.sessionId &&
        agent.sessionFingerprint === input.sessionFingerprint,
        "Context measurement conversation/agent identity mismatch");
      // Never reduce the known maximum, including across corrupted or lagged
      // provider measurements and full restart.
      agent.contextTokens = Math.max(agent.contextTokens ?? 0, input.tokens);
      agent.contextMeasuredAt = Date.now();
      if (this.policy.workerContextCeilingTokens !== undefined &&
        agent.contextTokens >= this.policy.workerContextCeilingTokens &&
        agent.status === "sleeping") agent.status = "terminal";
      existing.generation++;
      return {state:existing,result:{contextTokens:agent.contextTokens,status:agent.status}};
    });
  }

  /**
   * CoS stageFinish()/finishAgent() adaptation: worker finishes one unit and
   * sleeps in its *original* conversation. The result is atomically reported
   * to the requester (or Main Agent), not a terminal task approval.
   *
   * A repeated exact finish key returns the same report instead of creating
   * an extra message after an MCP response is lost.
   */
  async finishWork(input: { result: string; idempotencyKey: string; reportTo?: string }): Promise<DynamicMessage> {
    return this.perform((state, actor) => {
      invariant(actor.id !== "main_agent", "Main Agent does not finish worker work");
      invariant(typeof input.result === "string" && input.result.trim().length > 0 &&
        input.result.length <= MAX_MESSAGE_CHARS, "Invalid finish report");
      invariant(typeof input.idempotencyKey === "string" && input.idempotencyKey.length >= 8 &&
        input.idempotencyKey.length <= 128, "Invalid finish idempotency key");
      if (actor.status === "sleeping" || actor.status === "terminal") {
        invariant(actor.lastFinishKey === input.idempotencyKey && actor.lastResult === input.result,
          "Sleeping worker cannot finish a new work unit");
        const previous = state.messages.find(m =>
          m.from === actor.id && m.idempotencyKey === input.idempotencyKey);
        invariant(previous && (input.reportTo === undefined || previous.to === input.reportTo),
          "Previous finish report no longer has a matching recipient");
        return previous;
      }
      invariant(actor.status !== "blocked" && actor.status !== "waking" &&
        actor.status !== "terminal", "Worker with unresolved wake cannot finish work");
      const lastRequest = [...state.messages].reverse().find(m =>
        m.to === actor.id && m.kind === "work");
      const recipientId = input.reportTo ?? lastRequest?.from ?? "main_agent";
      invariant(recipientId !== actor.id && state.agents.some(a => a.id === recipientId),
        "Unknown finish report recipient");
      invariant(!state.messages.some(m => m.from === actor.id && m.idempotencyKey === input.idempotencyKey),
        "Finish idempotency key already used");
      invariant(state.messages.filter(m => m.to === recipientId && m.state !== "acked").length <
        this.policy.maxPendingPerAgent, "Finish report recipient inbox full");
      // Do not retire browser messages here: caller liveness alone does not
      // prove every prior Send was consumed. The separately verified ACK
      // protocol owns that transition (CoS finish/offer boundary).
      const report: DynamicMessage = { id: randomUUID(), taskKey: taskKey(state.task), from: actor.id,
        to: recipientId, kind: "evidence", body: input.result, idempotencyKey: input.idempotencyKey,
        ...(lastRequest ? { inReplyTo: lastRequest.id } : {}), state: "queued" };
      invariant(state.messages.length < (this.policy.maxRecordedMessages ?? 8192),
        "Message history limit reached; cannot safely discard accepted receipts");
      state.messages.push(report);
      actor.lastFinishKey = input.idempotencyKey;
      actor.lastResult = input.result;
      actor.status = this.policy.workerContextCeilingTokens !== undefined &&
        (actor.contextTokens ?? 0) >= this.policy.workerContextCeilingTokens ? "terminal" : "sleeping";
      return report;
    });
  }
  /**
   * CoS noteAgentAlive(): only a genuinely later, authenticated worker call
   * proves a restored conversation is executing. Old turn hydration, a page
   * observation, or the native browser Send receipt are insufficient.
   */
  async noteAgentAlive(call: VerifiedDynamicToolCall): Promise<boolean> {
    invariant(sameTask(call.task, this.policy.task) && typeof call.callId === "string" &&
      !!call.callId.trim() && Number.isSafeInteger(call.startedAt) && call.startedAt > 0,
      "Invalid worker liveness proof");
    invariant(await this.trust.verifyToolCall(call), "Unverified worker liveness call");
    return this.perform((state, actor) => {
      invariant(actor.id === call.recipientId && !!actor.sessionId, "Worker liveness identity mismatch");
      if (actor.status !== "waking") return false;
      const pendingWake = (state.wakeCommands ?? []).find(c =>
        c.recipientId === actor.id && c.state !== "alive");
      // An older, unrelated user message is NEVER proof of this wake.
      const confirmed = pendingWake
        ? pendingWake.state === "delivered" && pendingWake.deliveredAt! < call.startedAt
        : state.messages.some(m => m.to === actor.id &&
          (m.state === "sent" || m.state === "acked") &&
          m.providerDeliveredAt !== undefined && m.providerDeliveredAt < call.startedAt);
      if (!confirmed) return false;
      if (pendingWake) pendingWake.state = "alive";
      actor.status = "busy";
      return true;
    });
  }
  async requestFinalReview(): Promise<void> {
    const caller = await this.trust.resolveCaller();
    invariant(await this.trust.verifyIndependentReview?.({
      task: this.policy.task, requesterId: caller.agentId,
      sessionFingerprint: caller.sessionFingerprint
    }) === true, "Missing host-verified independent review evidence");
    await this.perform((state, actor) => {
      invariant(actor.id === caller.agentId &&
        actor.sessionFingerprint === caller.sessionFingerprint,
        "Reviewer caller changed during evidence verification");
      invariant(actor.id !== "main_agent", "Owner does not self-request review");
      invariant(state.messages.some(m => m.from === actor.id && m.kind === "evidence" && m.state === "acked"), "No acknowledged independent evidence");
      state.finalReviewRequested = true;
    });
  }
  async decideFinalReview(decision: "approved" | "changes_requested"): Promise<void> {
    await this.perform((state, actor) => {
      invariant(actor.id === "main_agent" && state.finalReviewRequested, "Main Agent review required");
      invariant(decision === "approved" || decision === "changes_requested", "Invalid owner decision");
      state.ownerDecision = decision; state.finalReviewRequested = false;
    });
  }
}
