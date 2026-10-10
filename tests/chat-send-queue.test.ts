import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSendQueueStore, type ChatSendIdentity } from "../src/chat-send-queue.js";

const identity: ChatSendIdentity = {
  repo: "owner/repo", issue: 232, workerId: "developer", turn: 3,
  turnTokenHash: "a".repeat(64), promptSha256: "b".repeat(64),
  conversationSha256: "c".repeat(64),
};

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "devos-send-queue-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("durably records waiting and arms a single exact turn before submission", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  assert.equal((await queue.begin()).status, "waiting_for_chat_idle");
  assert.equal((await queue.markReady()).status, "ready_to_send");
  const armed = await queue.arm();
  assert.equal(armed.status, "submission_pending");
  assert.equal(armed.globalBusy, "unknown");
  assert.ok(Date.parse(armed.deadlineAt) > Date.now());
  const restored = await new ChatSendQueueStore(root, identity).load();
  assert.equal(restored?.status, "submission_pending");
  const persisted = await readFile(queue.path, "utf8");
  assert.equal(persisted.includes("private prompt"), false);
  assert.equal((await stat(queue.path)).mode & 0o777, 0o600);
}));

test("restart or a concurrent runner cannot arm an already pending turn again", async () => fixture(async root => {
  const first = new ChatSendQueueStore(root, identity);
  await first.begin(); await first.markReady(); await first.arm();
  const resumed = new ChatSendQueueStore(root, identity);
  await assert.rejects(resumed.begin(), /already armed or unresolved/);
  await assert.rejects(resumed.arm(), /already armed or unresolved/);
}));

test("only exact receipt confirms a turn; ambiguous recovery is read-only and non-replayable", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  await queue.begin(); await queue.markReady(); await queue.arm();
  assert.throws(() => queue.confirm(""), /valid user message id/);
  await queue.markAmbiguous("click_timeout");
  await assert.rejects(new ChatSendQueueStore(root, identity).begin(), /already armed or unresolved/);
  assert.equal((await queue.load())?.status, "submission_ambiguous");
}));

test("a changed task, prompt, conversation or turn cannot share the saved lease", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  await queue.begin(); await queue.markReady(); await queue.arm();
  await assert.rejects(new ChatSendQueueStore(root, { ...identity, promptSha256: "d".repeat(64) }).load(), /identity mismatch/);
}));

test("a proven pre-submit retry refreshes exact prompt intent but an armed turn stays immutable", async () => fixture(async root => {
  const first = new ChatSendQueueStore(root, identity);
  await first.begin();
  const retried = new ChatSendQueueStore(root, { ...identity, turnTokenHash: "e".repeat(64), promptSha256: "d".repeat(64) });
  assert.equal((await retried.begin()).status, "waiting_for_chat_idle");
  assert.equal((await retried.load())?.identity.promptSha256, "d".repeat(64));
  await retried.markReady(); await retried.arm();
  const changedAfterArm = new ChatSendQueueStore(root, { ...identity, promptSha256: "f".repeat(64) });
  await assert.rejects(changedAfterArm.begin(), /identity mismatch/);
}));

test("a confirmed POST receipt remains terminal across process restart", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  await queue.begin(); await queue.markReady(); await queue.arm();
  await queue.confirm("user-message-42");
  const resumed = new ChatSendQueueStore(root, identity);
  assert.equal((await resumed.begin()).status, "submitted_confirmed");
  await assert.rejects(resumed.arm(), /already confirmed/);
  assert.equal((await resumed.load())?.messageId, "user-message-42");
}));

test("a duplicate POST revokes confirmation and permanently marks the turn ambiguous", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  await queue.begin(); await queue.markReady(); await queue.arm();
  await queue.confirm("user-message-42");
  const ambiguous = await queue.markAmbiguous("duplicate_post");
  assert.equal(ambiguous.status, "submission_ambiguous");
  assert.equal(ambiguous.messageId, undefined);
  assert.equal(ambiguous.receipt, undefined);
  await assert.rejects(new ChatSendQueueStore(root, identity).begin(), /already armed or unresolved/);
}));

test("a signed terminal MCP receipt confirms an armed turn without inventing a POST id", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  await queue.begin(); await queue.markReady(); await queue.arm();
  const confirmed = await queue.confirmMcp();
  assert.equal(confirmed.receipt, "signed_mcp_report");
  assert.equal(confirmed.messageId, undefined);
  assert.equal((await new ChatSendQueueStore(root, identity).begin()).status, "submitted_confirmed");
}));

test("expired readiness deadline is persisted as a truthful pre-submit block", async () => fixture(async root => {
  const queue = new ChatSendQueueStore(root, identity);
  await queue.begin(1);
  await new Promise(resolve => setTimeout(resolve, 5));
  const expired = await new ChatSendQueueStore(root, identity).begin(1);
  assert.equal(expired.status, "blocked");
  assert.equal(expired.reason, "readiness_deadline");
}));
