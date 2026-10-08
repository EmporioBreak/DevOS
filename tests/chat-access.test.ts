import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs } from "../src/cli.js";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ChatAccessRegistry, canonicalPrivateChatUrl, chatSessionSignal } from "../src/chat-access.js";
import { runChatAccessAdmin } from "../src/chat-access-admin.js";
import { ChatWorkerGrantRegistry } from "../src/chat-worker-grants.js";
import { startGateway } from "../src/connector-gateway.js";
import { oauthToken } from "./connector-auth-fixture.js";

const secret = "chat-access-test-secret-" + randomBytes(32).toString("hex");
const url = "https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0";
const parse = (r: any) => JSON.parse(r.content[0].text);

test("owner-only chat access CLI command parser", () => {
  assert.deepEqual(parseCliArgs(["connector", "access", "list"]),
    { kind: "chat_access", command: { action: "list" } });
  assert.deepEqual(parseCliArgs(["connector", "access", "approve", "chat_abc", url]),
    { kind: "chat_access", command: { action: "approve", fingerprint: "chat_abc", url } });
  assert.deepEqual(parseCliArgs(["connector", "access", "revoke", "chat_abc"]),
    { kind: "chat_access", command: { action: "revoke", fingerprint: "chat_abc" } });
  assert.throws(() => parseCliArgs(["connector", "access", "approve", "chat_abc"]), /Usage/);
});

test("canonical private chat validation and session signals fail closed", () => {
  assert.equal(canonicalPrivateChatUrl(url), url);
  assert.equal(canonicalPrivateChatUrl(url + "/"), url);
  assert.equal(canonicalPrivateChatUrl("https://chatgpt.com/g/p-abcdef123/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0"),
    "https://chatgpt.com/g/p-abcdef123/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
  for (const bad of [
    "https://chatgpt.com/share/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",
    url + "?q=unsafe", url + "#unsafe",
    "http://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",
    "https://other.test/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",
    "https://chatgpt.com/c/not-a-uuid",
    "https://chatgpt.com/g/a/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0/foo",
  ]) assert.throws(() => canonicalPrivateChatUrl(bad));

  const req = (meta?: unknown) => ({ method: "tools/call", params: { _meta: meta, arguments: {
    // User/model-supplied arguments are NEVER read as an identity.
    "openai/session": "fake-session-id", _devos_binding_token: "fake-session-id",
  } } });
  assert.equal(chatSessionSignal(req({ "openai/session": "chat-opaque-A" }), undefined), "chat-opaque-A");
  assert.equal(chatSessionSignal(req({ "openai/session": "chat-opaque-A" }), "chat-opaque-A"), "chat-opaque-A");
  assert.equal(chatSessionSignal(req(undefined), "header-chat-id"), "header-chat-id");
  assert.equal(chatSessionSignal(req({ "openai/session": "chat-opaque-A" }), "other-chat-id"), undefined);
  assert.equal(chatSessionSignal(req({ "openai/session": 123 }), "header-chat-id"), undefined);
  assert.equal(chatSessionSignal(req(undefined), undefined), undefined);
});

test("durable owner-local chat access approval, revocation and tamper protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-chat-access-test-"));
  try {
    const registry = new ChatAccessRegistry(root, secret);
    const ref = registry.fingerprint("oauth-client-A", "opaque-session-123");
    assert.ok(/^chat_[a-f0-9]{64}$/.test(ref));
    assert.notEqual(ref, registry.fingerprint("oauth-client-B", "opaque-session-123"));
    assert.notEqual(ref, registry.fingerprint("oauth-client-A", "opaque-session-456"));
    assert.equal(registry.isApproved(ref), false);
    assert.throws(() => registry.approve(ref, "https://chatgpt.com/share/invalid"));
    assert.equal(await runChatAccessAdmin(root, { action: "list" },
      { DEVOS_CONNECTOR_OWNER_SECRET: secret }).then(x => x.includes("No approved")), true);
    assert.equal(await runChatAccessAdmin(root, { action: "approve", fingerprint: ref, url },
      { DEVOS_CONNECTOR_OWNER_SECRET: secret }).then(x => x.includes("approved")), true);
    assert.equal(new ChatAccessRegistry(root, secret).isApproved(ref), true);
    assert.ok((await runChatAccessAdmin(root, { action: "list" }, { DEVOS_CONNECTOR_OWNER_SECRET: secret })).includes(ref));
    assert.throws(() => registry.approve(ref, "https://chatgpt.com/c/7ac799bd-7ffc-83eb-b2b0-15d6a2f558a0"), /Conflicting/);
    const file = join(root, ".devos/connector/chat-access.json");
    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes("opaque-session"));
    assert.ok(!raw.includes(secret));
    const contents = JSON.parse(raw);
    contents.entries[0].url = "https://chatgpt.com/c/7ac799bd-7ffc-83eb-b2b0-15d6a2f558a0";
    await writeFile(file, JSON.stringify(contents));
    assert.equal(registry.isApproved(ref), false, "changed grant fails MAC");
    assert.rejects(runChatAccessAdmin(root, { action: "list" },
      { DEVOS_CONNECTOR_OWNER_SECRET: secret }));
    await writeFile(file, raw);
    await chmod(file, 0o644);
    assert.equal(registry.isApproved(ref), false, "world-readable registry fails closed");
    await chmod(file, 0o600);
    assert.equal(registry.isApproved(ref), true);
    assert.equal((await runChatAccessAdmin(root, { action: "revoke", fingerprint: ref },
      { DEVOS_CONNECTOR_OWNER_SECRET: secret })).includes("revoked"), true);
    assert.equal(registry.isApproved(ref), false);
    await assert.rejects(runChatAccessAdmin(root, { action: "approve", fingerprint: ref, url }, {}),
      /Owner secret/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("authenticated MCP gateway rejects unapproved calls, supports owner grants and revocation", { timeout: 75_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-chat-gateway-"));
  const issuer = "https://devos-chat-gate.example";
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  const gateway = await startGateway({ root, port: 0, ownerSecret: secret, publicUrl: issuer, oauthClientsPath: null });
  const base = "http://127.0.0.1:" + gateway.address.port;
  const client = new Client({ name: "gate-test", version: "1" }, { capabilities: {} });
  let second: Client | undefined;
  let third: Client | undefined;
  try {
    const { tokens, client: oauthClient } = await oauthToken(base, secret, issuer + "/mcp");
    const authHeader = { Authorization: "Bearer " + tokens.access_token };
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { ...authHeader, "x-openai-session": "test-session-A" } },
    }) as Transport);

    const listed = (await client.listTools()).tools.map(t => t.name);
    for (const name of ["devos_noop", "devos_worker_probe", "read_file", "get_config", "devos_task_status", "devos_worker_report"])
      assert.ok(listed.includes(name), "missing " + name);
    assert.equal(listed.length, new Set(listed).size);
    const noop = parse(await client.callTool({ name: "devos_noop", arguments: {} }));
    assert.equal(noop.status, "no_action");
    assert.equal(noop.approved, false);
    assert.match(noop.chat_reference, /^chat_[a-f0-9]{64}$/);
    const safeProbe = parse(await client.callTool({ name: "devos_worker_probe", arguments: {} }));
    assert.equal(safeProbe.status, "issued");
    assert.match(safeProbe.nonce, /^[a-f0-9]{64}$/);
    assert.equal((await client.callTool({ name: "get_config", arguments: {} })).isError, true,
      "worker probe alone must not authorize operational MCP");
    const registry = new ChatAccessRegistry(root, secret);
    assert.equal(noop.chat_reference, registry.fingerprint(oauthClient.client_id, "test-session-A"));
    for (const name of ["get_config", "read_file", "devos_task_status", "devos_worker_report", "start_process"]) {
      const r = await client.callTool({ name, arguments: {} });
      assert.equal(r.isError, true, name + " must be blocked");
      assert.match((r.content as any[])[0].text, /not authorized/);
    }
    const shouldNotExist = join(root, "unauthorized-side-effect.txt");
    const processAttempt = await client.callTool({ name: "start_process",
      arguments: { command: "touch " + shouldNotExist, timeout_ms: 1000 } });
    assert.equal(processAttempt.isError, true);
    await assert.rejects(stat(shouldNotExist), { code: "ENOENT" });

    // Trusted on-host worker binder claims only after independent provider-
    // structured proof. This exercises actual gateway forwarding and revoke.
    const workerStatePath = join(root, ".devos", "state", "EmporioBreak%2FDevOS-issue-99.json");
    await mkdir(join(root, ".devos", "state"), { recursive: true });
    await writeFile(workerStatePath, JSON.stringify({
      currentWorkerId: "developer", completedRuns: 0,
      activeReport: { workerId: "developer", turn: 0 },
      sessions: { developer: url }, mainAgentReviewPending: false, completionApproved: false,
    }));
    const workerRegistry = new ChatWorkerGrantRegistry(root, secret);
    assert.equal(workerRegistry.bindVerified(safeProbe.nonce,
      { repo: "EmporioBreak/DevOS", issue: 99 }, "developer", 0, url), true);
    assert.notEqual((await client.callTool({ name: "get_config", arguments: {} })).isError, true,
      "verified active worker forwards to Desktop Commander without password");
    assert.notEqual((await client.callTool({ name: "devos_task_status",
      arguments: { repo: "Nobody/Nowhere", issue: 123456 } })).isError, true,
      "verified active worker may call first-party DevOS tools");
    workerRegistry.revoke({ repo: "EmporioBreak/DevOS", issue: 99 }, "developer");
    assert.equal((await client.callTool({ name: "get_config", arguments: {} })).isError, true,
      "revoked worker must immediately lose gateway forwarding");

    registry.approve(noop.chat_reference, url);
    assert.equal(parse(await client.callTool({ name: "devos_noop", arguments: {} })).approved, true);
    const mismatchedHostSignal = await client.callTool({
      name: "get_config", arguments: {},
      _meta: { "openai/session": "different-session-id" },
    } as any);
    assert.equal(mismatchedHostSignal.isError, true, "contradictory session metadata must fail closed");
    const upstream = await client.callTool({ name: "get_config", arguments: {} });
    assert.notEqual(upstream.isError, true, "approved chat forwards to Desktop Commander");
    const firstParty = await client.callTool({ name: "devos_task_status",
      arguments: { repo: "Nobody/Nowhere", issue: 123456 } });
    assert.deepEqual(parse(firstParty), { found: false, task: { repo: "Nobody/Nowhere", issue: 123456 } });

    second = new Client({ name: "other-session", version: "1" }, { capabilities: {} });
    await second.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { ...authHeader, "x-openai-session": "test-session-B" } },
    }) as Transport);
    assert.notEqual(parse(await second.callTool({ name: "devos_noop", arguments: {} })).chat_reference, noop.chat_reference);
    const otherProbe = parse(await second.callTool({ name: "devos_worker_probe", arguments: {} }));
    assert.equal(otherProbe.status, "issued");
    assert.notEqual(otherProbe.nonce, safeProbe.nonce);
    assert.equal((await second.callTool({ name: "get_config", arguments: {} })).isError, true);

    third = new Client({ name: "no-session", version: "1" }, { capabilities: {} });
    await third.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: authHeader },
    }) as Transport);
    assert.deepEqual(parse(await third.callTool({ name: "devos_noop", arguments: {} })), { status: "no_action", approved: false });
    assert.deepEqual(parse(await third.callTool({ name: "devos_worker_probe", arguments: {} })), { status: "unavailable" });
    assert.equal((await third.callTool({ name: "get_config", arguments: {} })).isError, true);

    const { tokens: otherTokens, client: otherOAuthClient } =
      await oauthToken(base, secret, issuer + "/mcp");
    const clientFromDifferentOAuth = new Client({ name: "other-oauth", version: "1" }, { capabilities: {} });
    try {
      await clientFromDifferentOAuth.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + otherTokens.access_token,
          "x-openai-session": "test-session-A" } },
      }) as Transport);
      assert.notEqual(otherOAuthClient.client_id, oauthClient.client_id);
      assert.equal((await clientFromDifferentOAuth.callTool({ name: "get_config", arguments: {} })).isError,
        true, "same session with another OAuth client must not inherit authorization");
    } finally { await clientFromDifferentOAuth.close(); }

    registry.revoke(noop.chat_reference);
    assert.equal(parse(await client.callTool({ name: "devos_noop", arguments: {} })).approved, false);
    assert.equal((await client.callTool({ name: "get_config", arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: "devos_task_status", arguments: {} })).isError, true);
  } finally {
    await Promise.allSettled([client.close(), second?.close(), third?.close()]);
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});
