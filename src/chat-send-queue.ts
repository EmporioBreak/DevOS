import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessIdentity } from "./process-identity.js";
import { captureProcessIdentity, processExists, sameProcessIdentity } from "./process-identity.js";

export interface ChatSendIdentity {
  repo: string;
  issue: number;
  workerId: string;
  turn: number;
  turnTokenHash: string;
  promptSha256: string;
  conversationSha256: string;
}

export type ChatSendStatus = "waiting_for_chat_idle" | "ready_to_send" | "submission_pending" | "submitted_confirmed" | "submission_ambiguous" | "blocked";
export interface ChatSendRecord {
  version: 1;
  identity: ChatSendIdentity;
  status: ChatSendStatus;
  globalBusy: "unknown";
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  messageId?: string;
  receipt?: "conversation_post" | "signed_mcp_report";
  reason?: "click_timeout" | "transport_loss" | "duplicate_post" | "receipt_lost" | "readiness_deadline" | "authentication" | "challenge" | "scope_mismatch" | "cancelled";
}

export class ChatSendQueueStore {
  readonly path: string;
  private readonly lockPath: string;
  private readonly key: string;

  constructor(private readonly root: string, private readonly identity: ChatSendIdentity) {
    validateIdentity(identity);
    const taskKey = `${encodeURIComponent(identity.repo)}-issue-${identity.issue}`;
    this.key = createHash("sha256").update(`${identity.workerId}\0${identity.turn}`).digest("hex");
    const dir = join(root, ".devos", "send-queue");
    this.path = join(dir, `${taskKey}-${this.key}.json`);
    this.lockPath = `${this.path}.lock`;
  }

  async load(): Promise<ChatSendRecord | null> {
    try {
      const record = validateRecord(JSON.parse(await readFile(this.path, "utf8")));
      if (!sameIdentity(record.identity, this.identity)) throw new Error("Chat send queue identity mismatch");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  begin(deadlineMs = 5 * 60_000): Promise<ChatSendRecord> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("Invalid chat send queue deadline");
    return this.update(existing => {
      if (!existing) return this.makeRecord("waiting_for_chat_idle", deadlineMs);
      if ((existing.status === "waiting_for_chat_idle" || existing.status === "ready_to_send") && Date.parse(existing.deadlineAt) <= Date.now())
        return { ...touch(existing), status: "blocked", reason: "readiness_deadline" };
      if (existing.status === "submitted_confirmed") return existing;
      if (existing.status === "waiting_for_chat_idle" || existing.status === "ready_to_send")
        return { ...touch(existing), identity: { ...this.identity } };
      throw new Error("Chat send turn is already armed or unresolved; refusing replay");
    }, true);
  }

  markReady(): Promise<ChatSendRecord> {
    return this.update(existing => {
      if (!existing) throw new Error("Chat send queue is not waiting for readiness");
      if (existing.status === "ready_to_send") return existing;
      if (existing.status !== "waiting_for_chat_idle") throw new Error("Chat send queue is not waiting for readiness");
      return { ...touch(existing), status: "ready_to_send" };
    });
  }

  arm(): Promise<ChatSendRecord> {
    return this.update(existing => {
      if (!existing) throw new Error("Chat send queue intent is missing");
      if (existing.status === "submitted_confirmed") throw new Error("Chat send turn is already confirmed");
      if (existing.status !== "ready_to_send") throw new Error("Chat send turn is already armed or unresolved; refusing replay");
      return { ...touch(existing), status: "submission_pending" };
    });
  }

  confirm(messageId: string): Promise<ChatSendRecord> {
    if (typeof messageId !== "string" || !messageId.trim() || messageId.length > 200) throw new Error("A valid user message id is required to confirm submission");
    return this.update(existing => {
      if (!existing) throw new Error("Chat send queue intent is missing");
      if (existing.status === "submitted_confirmed" && existing.messageId === messageId) return existing;
      if (existing.status !== "submission_pending") throw new Error("Only an armed chat send can be confirmed");
      return { ...touch(existing), status: "submitted_confirmed", messageId, receipt: "conversation_post" };
    });
  }

  confirmMcp(): Promise<ChatSendRecord> {
    return this.update(existing => {
      if (!existing) throw new Error("Chat send queue intent is missing");
      if (existing.status === "submitted_confirmed") return existing;
      if (existing.status !== "submission_pending") throw new Error("Only an armed chat send can be confirmed");
      return { ...touch(existing), status: "submitted_confirmed", receipt: "signed_mcp_report" };
    });
  }

  markAmbiguous(reason: NonNullable<ChatSendRecord["reason"]>): Promise<ChatSendRecord> {
    return this.update(existing => {
      if (!existing) throw new Error("Chat send queue intent is missing");
      if (existing.status === "submission_ambiguous") return existing;
      if (existing.status === "submitted_confirmed" && reason === "duplicate_post") {
        const { messageId: _messageId, receipt: _receipt, ...withoutReceipt } = existing;
        return { ...touch(withoutReceipt), status: "submission_ambiguous", reason };
      }
      if (existing.status !== "submission_pending") throw new Error("Only an armed chat send can become ambiguous");
      return { ...touch(existing), status: "submission_ambiguous", reason };
    });
  }

  block(reason: NonNullable<ChatSendRecord["reason"]>): Promise<ChatSendRecord> {
    return this.update(existing => {
      if (!existing) throw new Error("Chat send queue intent is missing");
      if (existing.status === "blocked") return existing;
      if (existing.status !== "waiting_for_chat_idle" && existing.status !== "ready_to_send")
        throw new Error("Only a pre-submit chat send can be blocked");
      return { ...touch(existing), status: "blocked", reason };
    });
  }

  private makeRecord(status: ChatSendStatus, deadlineMs: number): ChatSendRecord {
    const now = new Date().toISOString();
    return { version: 1, identity: { ...this.identity }, status, globalBusy: "unknown", createdAt: now, updatedAt: now,
      deadlineAt: new Date(Date.now() + deadlineMs).toISOString() };
  }

  private async update(change: (existing: ChatSendRecord | null) => ChatSendRecord, allowSafePreSubmitRefresh = false): Promise<ChatSendRecord> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const release = await acquireLock(this.lockPath);
    try {
      let existing: ChatSendRecord | null;
      try { existing = validateRecord(JSON.parse(await readFile(this.path, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existing = null; else throw error; }
      if (existing && !sameIdentity(existing.identity, this.identity) &&
          !(allowSafePreSubmitRefresh && (existing.status === "waiting_for_chat_idle" || existing.status === "ready_to_send") && sameLease(existing.identity, this.identity)))
        throw new Error("Chat send queue identity mismatch");
      const next = validateRecord(change(existing));
      if (!sameIdentity(next.identity, this.identity)) throw new Error("Chat send queue identity mismatch");
      const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(next)}\n`, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temp, this.path);
      await chmod(this.path, 0o600);
      const dir = await open(dirname(this.path), "r");
      try { await dir.sync(); } finally { await dir.close(); }
      return next;
    } finally { await release(); }
  }
}

function validateIdentity(value: ChatSendIdentity): void {
  if (!value || !/^[^/\s]+\/[^/\s]+$/.test(value.repo) || !Number.isSafeInteger(value.issue) || value.issue < 1 ||
      !value.workerId.trim() || !Number.isSafeInteger(value.turn) || value.turn < 0 ||
      ![value.turnTokenHash, value.promptSha256, value.conversationSha256].every(item => /^[a-f0-9]{64}$/.test(item)))
    throw new Error("Invalid chat send queue identity");
}

function sameIdentity(a: ChatSendIdentity, b: ChatSendIdentity): boolean {
  return a.repo === b.repo && a.issue === b.issue && a.workerId === b.workerId && a.turn === b.turn &&
    a.promptSha256 === b.promptSha256 && a.conversationSha256 === b.conversationSha256;
}

function sameLease(a: ChatSendIdentity, b: ChatSendIdentity): boolean {
  return a.repo === b.repo && a.issue === b.issue && a.workerId === b.workerId && a.turn === b.turn;
}

function touch(record: ChatSendRecord): ChatSendRecord { return { ...record, updatedAt: new Date().toISOString() }; }

function validateRecord(value: unknown): ChatSendRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid chat send queue record");
  const record = value as ChatSendRecord;
  validateIdentity(record.identity);
  if (record.version !== 1 || !["waiting_for_chat_idle", "ready_to_send", "submission_pending", "submitted_confirmed", "submission_ambiguous", "blocked"].includes(record.status) ||
      record.globalBusy !== "unknown" || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) ||
      !Number.isFinite(Date.parse(record.deadlineAt)) ||
      (record.status === "submitted_confirmed" && (record.receipt === "conversation_post"
        ? (!record.messageId || record.messageId.length > 200)
        : record.receipt !== "signed_mcp_report"))) throw new Error("Invalid chat send queue record");
  return record;
}

export async function readTaskChatSendQueues(root: string, task: { repo: string; issue: number }): Promise<Array<{
  workerId: string; turn: number; status: ChatSendStatus; globalBusy: "unknown";
  deadlineAt: string; reason?: Exclude<ChatSendRecord["reason"], undefined>; receipt?: Exclude<ChatSendRecord["receipt"], undefined>;
}>> {
  const dir = join(root, ".devos", "send-queue");
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const prefix = `${encodeURIComponent(task.repo)}-issue-${task.issue}-`;
  const records: ChatSendRecord[] = [];
  for (const name of names.filter(name => name.startsWith(prefix) && name.endsWith(".json")).sort().slice(-100)) {
    const record = validateRecord(JSON.parse(await readFile(join(dir, name), "utf8")));
    if (record.identity.repo !== task.repo || record.identity.issue !== task.issue) throw new Error("Chat send queue task identity mismatch");
    records.push(record);
  }
  return records.sort((a, b) => a.identity.turn - b.identity.turn).map(record => ({
    workerId: record.identity.workerId, turn: record.identity.turn, status: record.status,
    globalBusy: record.globalBusy, deadlineAt: record.deadlineAt,
    ...(record.reason ? { reason: record.reason } : {}), ...(record.receipt ? { receipt: record.receipt } : {}),
  }));
}

interface LockRecord { pid: number; runId: string; identity: ProcessIdentity }
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const runId = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      const identity = await captureProcessIdentity(process.pid);
      if (!identity) { await handle.close(); await rm(path, { force: true }); throw new Error("Cannot prove send queue lock owner"); }
      await handle.writeFile(JSON.stringify({ pid: process.pid, runId, identity } satisfies LockRecord));
      await handle.sync(); await handle.close();
      return async () => {
        try { const current = JSON.parse(await readFile(path, "utf8")) as LockRecord; if (current.runId === runId && current.pid === process.pid) await rm(path, { force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: LockRecord;
      try { current = JSON.parse(await readFile(path, "utf8")) as LockRecord; }
      catch { throw new Error("Send queue lock ownership is unknown; refusing to continue"); }
      const live = await processExists(current.pid);
      const actual = live ? await captureProcessIdentity(current.pid) : null;
      if (live && (!actual || sameProcessIdentity(current.identity, actual))) throw new Error("Chat send queue is locked by another active runner");
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire chat send queue lock");
}
