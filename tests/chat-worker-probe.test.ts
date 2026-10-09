import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

test("only a fresh signed pending probe for the exact fingerprint enables bounded waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-pending-"));
  try {
    const registry = new ChatWorkerProbeRegistry(root, secret);
    assert.equal(registry.hasFreshPending(fingerprintA, 10_000), false);
    const pending = registry.issue(fingerprintA, 10_000);
    assert.equal(pending.status, "issued");
    assert.equal(registry.hasFreshPending(fingerprintA, 10_001), true);
    assert.equal(registry.hasFreshPending(fingerprintB, 10_001), false);
    assert.equal(registry.hasFreshPending(fingerprintA, 130_000), false, "expired probe must not wait");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tampered pending probes do not enable waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-pending-tamper-"));
  try {
    const registry = new ChatWorkerProbeRegistry(root, secret);
    const pending = registry.issue(fingerprintA, 20_000);
    assert.equal(pending.status, "issued");
    const directory = join(root, ".devos", "connector", "worker-probes");
    const file = join(directory, (await readdir(directory))[0]!);
    const row = JSON.parse(await readFile(file, "utf8"));
    row.fingerprint = fingerprintB;
    await writeFile(file, JSON.stringify(row));
    assert.equal(registry.hasFreshPending(fingerprintA, 20_001), false);
    assert.equal(registry.hasFreshPending(fingerprintB, 20_001), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("hostile probe catalogs beyond the bounded candidate limit fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-hostile-catalog-"));
  try {
    const registry = new ChatWorkerProbeRegistry(root, secret);
    const directory = join(root, ".devos", "connector", "worker-probes");
    await mkdir(directory, { recursive: true });
    const genuine = registry.issue(fingerprintA);
    assert.equal(genuine.status, "issued");
    const genuineFile = (await readdir(directory))[0]!;
    const authenticBytes = await readFile(join(directory, genuineFile));
    // Every name carries an authentic signed row. The scanner must still reject
    // an over-cap catalog rather than treating a partial view as sufficient.
    await Promise.all(Array.from({ length: 128 }, (_, i) =>
      writeFile(join(directory, (i + 1).toString(16).padStart(64, "0") + ".json"), authenticBytes)));
    assert.equal(registry.hasFreshPending(fingerprintA), false);
    assert.equal(registry.issue(fingerprintA).status, "capacity");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pending probe scan resists a file swap between discovery and open", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-worker-probe-symlink-"));
  try {
    const registry = new ChatWorkerProbeRegistry(root, secret);
    const issued = registry.issue(fingerprintA);
    assert.equal(issued.status, "issued");
    if (issued.status !== "issued") return;
    const directory = join(root, ".devos", "connector", "worker-probes");
    const files = await readdir(directory);
    const candidate = join(directory, files[0]!);
    const replacement = join(root, "replacement-probe.json");
    await writeFile(replacement, await readFile(candidate), { mode: 0o600 });
    const fsModule = await import("node:fs");
    const fs = fsModule.default;
    const originalOpen = fs.openSync;
    let swapped = false;
    fs.openSync = ((path: string | Buffer | URL, flags: number | string, mode?: number) => {
      if (!swapped && path === candidate) {
        swapped = true;
        fs.unlinkSync(candidate);
        fs.renameSync(replacement, candidate);
      }
      return originalOpen(path, flags as any, mode);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.equal(registry.hasFreshPending(fingerprintA), false); }
    finally {
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(swapped, true, "test replaced the file after enumeration, immediately before open");
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

test("pending-check is session-pinned, signed, unexpired and never a grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-pending-proof-"));
  try {
    const reg = new ChatWorkerProbeRegistry(root, secret);
    assert.equal(reg.hasPendingFor(fingerprintA), false);
    const challenge = reg.issue(fingerprintA, 10_000_000);
    assert.equal(challenge.status, "issued");
    if (challenge.status !== "issued") return;
    assert.equal(reg.hasPendingFor(fingerprintA, 10_000_001), true);
    assert.equal(reg.hasPendingFor(fingerprintB, 10_000_001), false);
    assert.equal(reg.hasPendingFor(fingerprintA, 10_120_000), false);
    const dir = join(root, ".devos", "connector", "worker-probes");
    const file = join(dir, (await readdir(dir))[0]!);
    const tampered = JSON.parse(await readFile(file, "utf8"));
    tampered.expiresAt += 20_000;
    await writeFile(file, JSON.stringify(tampered));
    assert.equal(reg.hasPendingFor(fingerprintA, 10_000_002), false,
      "unsigned extension of a pending worker challenge is not trusted");
    assert.equal(reg.claim(challenge.nonce, 10_000_003), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
