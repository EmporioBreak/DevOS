import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatWorkerProbeRegistry, exactWorkerProbeResult } from "../src/chat-worker-probe.js";

const secret = randomBytes(32).toString("hex");
const fingerprintA = "chat_" + "a".repeat(64);
const fingerprintB = "chat_" + "b".repeat(64);
const uri = "/asdk_app_known/link_known/devos_worker_probe";

test("worker challenge is one-time, session-bound and never grants by itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-probe-"));
  try {
    const registry = new ChatWorkerProbeRegistry(root, secret);
    assert.deepEqual(registry.issue(undefined), { status: "unavailable" });
    const challenge = registry.issue(fingerprintA, 1_000_000);
    assert.equal(challenge.status, "issued");
    if (challenge.status !== "issued") return;
    assert.match(challenge.nonce, /^[a-f0-9]{64}$/);
    assert.equal(challenge.expires_in_seconds, 120);
    const directory = join(root, ".devos", "connector", "worker-probes");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const pending = await readFile(join(directory, files[0]!), "utf8");
    assert.ok(!pending.includes(challenge.nonce), "nonce must not persist in raw form");
    assert.equal((await stat(join(directory, files[0]!))).mode & 0o077, 0);
    assert.equal(registry.claim("0".repeat(64), 1_000_001), null);
    assert.equal(registry.claim(challenge.nonce, 1_000_002), fingerprintA);
    assert.equal(registry.claim(challenge.nonce, 1_000_003), null, "replay must fail");
    const other = registry.issue(fingerprintB, 1_002_000);
    assert.equal(other.status, "issued");
    if (other.status !== "issued") return;
    assert.equal(registry.claim(other.nonce, 1_122_000), null, "expiry must refuse");
    assert.equal(registry.claim(other.nonce, 1_122_001), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tampered or wrong-key challenges fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-tamper-"));
  try {
    const registry = new ChatWorkerProbeRegistry(root, secret);
    const challenge = registry.issue(fingerprintA, 5_000_000);
    assert.equal(challenge.status, "issued");
    if (challenge.status !== "issued") return;
    const directory = join(root, ".devos", "connector", "worker-probes");
    const file = join(directory, (await readdir(directory))[0]!);
    const object = JSON.parse(await readFile(file, "utf8"));
    object.fingerprint = fingerprintB;
    await writeFile(file, JSON.stringify(object));
    assert.equal(registry.claim(challenge.nonce, 5_000_001), null);
    assert.equal((await readdir(directory)).length, 0, "tampered challenge consumed without authorization");
    const second = registry.issue(fingerprintA, 5_000_010);
    assert.equal(second.status, "issued");
    if (second.status !== "issued") return;
    const foreign = new ChatWorkerProbeRegistry(root, randomBytes(32).toString("hex"));
    assert.equal(foreign.claim(second.nonce, 5_000_011), null);
    assert.equal(registry.claim(second.nonce, 5_000_012), fingerprintA);
    const third = registry.issue(fingerprintA, 5_000_020);
    assert.equal(third.status, "issued");
    if (third.status !== "issued") return;
    await chmod(join(directory, (await readdir(directory))[0]!), 0o644);
    assert.equal(registry.claim(third.nonce, 5_000_021), null, "unsafe file mode must fail");
  } finally { await rm(root, { recursive: true, force: true }); }
});

function providerTool(result: unknown, resourceUri = uri) {
  return { author: { role: "tool", name: "api_tool.call_tool" }, status: "finished_successfully",
    metadata: { invoked_resource: { resource_uri: resourceUri } },
    content: { content_type: "code", text: JSON.stringify({ result: { structuredContent: result } }) } };
}

test("only exact provider tool result can establish browser evidence", () => {
  const nonce = "c".repeat(64);
  const result = { status: "issued", nonce, expires_in_seconds: 120 };
  const proper = providerTool(result);
  assert.equal(exactWorkerProbeResult(proper, uri), nonce);
  assert.equal(exactWorkerProbeResult(proper, "/wrong/tool/devos_worker_probe"), null);
  assert.equal(exactWorkerProbeResult(providerTool(result, "/fake/app/devos_worker_probe"), uri), null);
  assert.equal(exactWorkerProbeResult({ ...proper, author: { role: "assistant", name: "api_tool.call_tool" } }, uri), null);
  assert.equal(exactWorkerProbeResult({ ...proper, author: { role: "tool", name: "functions.exec" } }, uri), null);
  assert.equal(exactWorkerProbeResult({ ...proper, status: "in_progress" }, uri), null);
  assert.equal(exactWorkerProbeResult({ ...proper, content: { content_type: "text", parts: [JSON.stringify(result)] } }, uri), null);
  assert.equal(exactWorkerProbeResult(providerTool({ status: "issued", nonce: "wrong" }), uri), null);
  assert.equal(exactWorkerProbeResult(providerTool({ status: "unavailable", nonce }), uri), null);
  assert.equal(exactWorkerProbeResult("DEVOS worker probe " + nonce, uri), null);
  assert.equal(exactWorkerProbeResult(proper, ""), null);
});
