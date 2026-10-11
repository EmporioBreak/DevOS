import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const loadBroker = async () => {
  try { return await import("../src/browser-command-broker.js"); }
  catch { return null; }
};

const ownerSecret = "test-owner-secret-that-is-at-least-thirty-two-bytes";
const { signBrowserCommandAuthorization,signBrowserCommandExecution,verifyBrowserCommandAuthorization } = await import("../src/browser-command-identity.js");

const commandAuth = {
  repo: "EmporioBreak/DevOS", issue: 239, pr: 240, workerId: "developer", turn: 1,
  commandId: "cmd-239-1", reportTokenHash: "b".repeat(64), graphSha256: "c".repeat(64),
  workerManifestSha256: "d".repeat(64), expiresAt: Date.now() + 60_000,conversationId:"conversation-a",
};
const unsignedCommand = {
  ...commandAuth, authorizationMac: signBrowserCommandAuthorization(commandAuth, ownerSecret),
  runtimeIncarnation: "runtime-a", profileOwner: "profile-a",
  windowLease: "window-239", tabLease: "tab-239", documentId: "doc-a",
  navigationEpoch: 4, conversationId: "conversation-a",
  payloadSha256: "a".repeat(64),
};
const command={...unsignedCommand,executionMac:signBrowserCommandExecution(unsignedCommand as any,ownerSecret)};

test("browser command claim is durable, exact and non-replayable after an ambiguous send", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-broker-"));
  try {
    const api = await loadBroker();
    assert.ok(api, "BrowserCommandBroker implementation is missing");
    const broker = new api.BrowserCommandBroker(root, ownerSecret);
    await broker.prepare(command);
    assert.equal(await broker.claim(command.commandId, command), true);
    await broker.markAmbiguous(command.commandId);

    const restarted = new api.BrowserCommandBroker(root);
    assert.equal(await restarted.claim(command.commandId, command), false);
    assert.equal((await restarted.get(command.commandId))?.status, "ambiguous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale A→B→A document epoch cannot claim or acknowledge another browser document", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-epoch-"));
  try {
    const api = await loadBroker();
    assert.ok(api, "BrowserCommandBroker implementation is missing");
    const broker = new api.BrowserCommandBroker(root, ownerSecret);
    assert.equal(typeof broker.acknowledge, "function", "provider receipt ACK is missing");
    await broker.prepare(command);
    const stale = { ...command, navigationEpoch: 3 };
    await assert.rejects(broker.claim(command.commandId, stale), /document claim/i);
    assert.equal(await broker.claim(command.commandId, command), true);
    await assert.rejects(broker.acknowledge(command.commandId, {
      ...command, messageId: "provider-message-1", payloadSha256: "b".repeat(64),
    }), /receipt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider receipt is durable before ACK and binds the exact task, turn, conversation and payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-receipt-"));
  try {
    const api = await loadBroker();
    assert.ok(api, "BrowserCommandBroker implementation is missing");
    const broker = new api.BrowserCommandBroker(root, ownerSecret);
    assert.equal(typeof broker.recordProviderReceipt, "function", "provider receipt persistence is missing");
    assert.equal(typeof broker.acknowledge, "function", "provider receipt ACK is missing");
    await broker.prepare(command);
    assert.equal(await broker.claim(command.commandId, command), true);
    const receipt = {
      repo: command.repo, issue: command.issue, workerId: command.workerId,
      turn: command.turn, commandId: command.commandId, payloadSha256: command.payloadSha256,
      conversationId: command.conversationId!, messageId: "provider-message-1",
    };
    await assert.rejects(broker.acknowledge(command.commandId, receipt), /persisted exact provider receipt/i);
    await broker.recordProviderReceipt(command.commandId, receipt);
    const restarted = new api.BrowserCommandBroker(root);
    assert.equal((await restarted.get(command.commandId))?.status, "received");
    await restarted.acknowledge(command.commandId, receipt);
    assert.equal((await restarted.get(command.commandId))?.status, "acknowledged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separate Node processes can claim one command only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-ipc-"));
  try {
    const api = await loadBroker();
    assert.ok(api, "BrowserCommandBroker implementation is missing");
    const broker = new api.BrowserCommandBroker(root, ownerSecret);
    await broker.prepare(command);
    const script = [
      'import { BrowserCommandBroker } from "./src/browser-command-broker.ts";',
      'const broker = new BrowserCommandBroker(process.argv[1]);',
      'const claim = JSON.parse(process.argv[2]);',
      'const won = await broker.claim(claim.commandId, claim);',
      'process.stdout.write(won ? "claimed" : "already-claimed");',
    ].join("\n");
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, JSON.stringify(command)], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)));
    });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.sort(), ["already-claimed", "claimed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broker cannot mint native execution attestations for caller-selected owner destinations",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-command-"));
  try{
    const api=await loadBroker();
    assert.ok(api,"BrowserCommandBroker implementation is missing");
    const broker=new api.BrowserCommandBroker(root,ownerSecret);
    const unsigned={...command,purpose:"owner_wakeup" as const,workerId:"main_agent_owner",
      ownerFingerprint:"chat_"+"e".repeat(64),ownerBindingSha256:"f".repeat(64),
      turn:2,commandId:"owner-wakeup-239-round-2",reportTokenHash:"1".repeat(64),
      conversationId:"owner-conversation"};
    assert.equal(typeof (broker as any).signOwnerWakeup,"undefined");
    const withGrant={...unsigned,authorizationMac:signBrowserCommandAuthorization(unsigned as any,ownerSecret)};
    const signed={...withGrant,executionMac:signBrowserCommandExecution(withGrant as any,ownerSecret)};
    await broker.prepare(signed);
    assert.equal(await broker.claim(signed.commandId,signed),true);
    const receipt={repo:signed.repo,issue:signed.issue,workerId:signed.workerId,
      turn:signed.turn,commandId:signed.commandId,payloadSha256:signed.payloadSha256,
      conversationId:signed.conversationId!,messageId:"provider-owner-message-2",
      purpose:"owner_wakeup" as const,ownerFingerprint:signed.ownerFingerprint!,
      ownerBindingSha256:signed.ownerBindingSha256!};
    await broker.recordProviderReceipt(signed.commandId,receipt);
    await broker.acknowledge(signed.commandId,receipt);
    assert.equal((await broker.get(signed.commandId))?.status,"acknowledged");
    assert.equal(verifyBrowserCommandAuthorization({...signed,ownerFingerprint:"chat_"+"a".repeat(64)},ownerSecret),false,
      "destination changes must invalidate the adapter grant signature");
  }finally{await rm(root,{recursive:true,force:true})}
});
