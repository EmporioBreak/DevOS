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
  maxPendingPerAgent: number;
  roles: Record<string, { executor: ExecutorKind; manifestSha256: string; mayAdmit: boolean }>;
}
export interface VerifiedDynamicCaller {
  task: TaskRef;
  agentId: string;
  sessionFingerprint: string;
}
export type DynamicMessageKind = "work" | "question" | "review" | "evidence" | "blocker";
export type DynamicMessageState = "queued" | "dispatch_uncertain" | "sent" | "acked";
export type DynamicAgentStatus = "idle" | "busy" | "sleeping" | "blocked";
export interface DynamicAgent {
  id: string;
  role: string;
  executor: ExecutorKind | "main_agent";
  manifestSha256: string | null;
  sessionFingerprint: string;
  sessionId?: string;
  status: DynamicAgentStatus;
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
}
export interface DynamicStatusView {
  task: TaskRef;
  generation: number;
  agents: Array<Pick<DynamicAgent, "id" | "role" | "executor" | "status">>;
  messages: DynamicMessage[];
  finalReviewRequested: boolean;
  ownerDecision?: "approved" | "changes_requested";
}
export interface DynamicSnapshot {
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
  invariant(Number.isSafeInteger(policy.maxPendingPerAgent) && policy.maxPendingPerAgent >= 1 && policy.maxPendingPerAgent <= 256, "Invalid inbox limit");
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
  invariant(typeof state.finalReviewRequested === "boolean", "Invalid review state");
  invariant(state.ownerDecision === undefined || state.ownerDecision === "approved" || state.ownerDecision === "changes_requested", "Invalid owner decision");
  const ids = new Set<string>();
  for (const agent of state.agents) {
    invariant(IDENT.test(agent.id) && !ids.has(agent.id), "Duplicate or invalid dynamic agent");
    invariant(typeof agent.sessionFingerprint === "string" && !!agent.sessionFingerprint, "Missing agent proof binding");
    ids.add(agent.id);
  }
  invariant(ids.has("main_agent"), "Missing Main Agent identity");
  const msgIds = new Set<string>();
  const dedupe = new Set<string>();
  for (const msg of state.messages) {
    invariant(typeof msg.id === "string" && !msgIds.has(msg.id), "Duplicate message identity");
    invariant(msg.taskKey === taskKey(state.task) && ids.has(msg.from) && ids.has(msg.to), "Cross-task or unknown message identity");
    invariant(["queued", "dispatch_uncertain", "sent", "acked"].includes(msg.state), "Invalid delivery state");
    invariant(msg.body.length > 0 && msg.body.length <= MAX_MESSAGE_CHARS, "Invalid message length");
    const key = `${msg.from}\u0000${msg.idempotencyKey}`;
    invariant(!dedupe.has(key), "Duplicate idempotency identity");
    msgIds.add(msg.id); dedupe.add(key);
  }
  return state;
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
  verifyNewAgentBinding(binding: { task: TaskRef; id: string; role: string; sessionFingerprint: string }): Promise<boolean>;
  verifyTransportLease(lease: DynamicTransportLease): Promise<boolean>;
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
        messages: [], finalReviewRequested: false,
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

  async admit(input: { id: string; role: string; sessionFingerprint: string }): Promise<DynamicAgent> {
    invariant(await this.trust.verifyNewAgentBinding({ ...input, task: this.policy.task }), "Unverified new agent identity");
    return this.perform((state, actor) => {
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
  async send(input: { to: string; kind: DynamicMessageKind; body: string; idempotencyKey: string; inReplyTo?: string }): Promise<DynamicMessage> {
    return this.perform((state, actor) => {
      invariant(["work", "question", "review", "evidence", "blocker"].includes(input.kind), "Unknown message kind");
      invariant(typeof input.body === "string" && input.body.trim().length > 0 && input.body.length <= MAX_MESSAGE_CHARS, "Invalid message body");
      invariant(typeof input.idempotencyKey === "string" && input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128, "Invalid idempotency key");
      invariant(input.to !== actor.id && state.agents.some(a => a.id === input.to), "Unknown recipient or self-send");
      invariant(!input.inReplyTo || state.messages.some(m => m.id === input.inReplyTo && (m.to === actor.id || m.from === actor.id)), "Invalid reply chain");
      const existing = state.messages.find(m => m.from === actor.id && m.idempotencyKey === input.idempotencyKey);
      if (existing) {
        invariant(existing.to === input.to && existing.kind === input.kind && existing.body === input.body && existing.inReplyTo === input.inReplyTo, "Idempotency-key payload conflict");
        return existing;
      }
      invariant(state.messages.filter(m => m.to === input.to && m.state !== "acked").length < this.policy.maxPendingPerAgent, "Inbox budget exhausted");
      const msg: DynamicMessage = { id: randomUUID(), taskKey: taskKey(state.task), from: actor.id,
        to: input.to, kind: input.kind, body: input.body, idempotencyKey: input.idempotencyKey,
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}), state: "queued" };
      state.messages.push(msg);
      return msg;
    });
  }
  /** Commit the uncertain dispatch fence before touching ChatGPT/Codex. */
  async claimForDelivery(messageId: string): Promise<DynamicMessage> {
    return this.perform((state, actor) => {
      const msg = state.messages.find(m => m.id === messageId && m.to === actor.id);
      invariant(msg && msg.state === "queued", "Message not claimable; may already have been submitted");
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
      invariant(msg.state === "queued", "Message not claimable; may already have been submitted");
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
  async requestFinalReview(): Promise<void> {
    await this.perform((state, actor) => {
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
