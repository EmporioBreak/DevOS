import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ChatAccessRegistry } from "../src/chat-access.js";
import { ChatApprovalTickets, CHAT_APPROVAL_WIDGET_URI, chatApprovalWidget } from "../src/chat-access-widget.js";
import { startGateway } from "../src/connector-gateway.js";
import { oauthToken } from "./connector-auth-fixture.js";

const url = "https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0";
const owner = "owner-secret-" + randomBytes(32).toString("hex");
const password = "approval-password-" + randomBytes(32).toString("hex");
const mobileShareUrl = "https://chatgpt.com/share/6ac864aa-fc90-83ed-8d16-91a75fb01000";
const payload = (r: any) => r.structuredContent || JSON.parse(r.content[0].text);

test("tickets are bounded, one-use, password-checked and bound to approved chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-inline-approve-unit-"));
  try {
    const registry = new ChatAccessRegistry(root, owner);
    const tickets = new ChatApprovalTickets(root, registry, password);
    assert.deepEqual(tickets.issue(undefined), { ready: false, reason: "missing_session" });
    assert.deepEqual(new ChatApprovalTickets(root, registry).issue("chat_" + "a".repeat(64)),
      { ready: false, reason: "password_not_configured" });
    const fingerprint = registry.fingerprint("client-A", "conversation-A");
    const ticket = tickets.issue(fingerprint).ticket as string;
    assert.equal(typeof ticket, "string");
    assert.equal(registry.isApproved(fingerprint), false);
    assert.equal(tickets.approve({ ticket, url, password: "wrong" }), false);
    assert.equal(registry.isApproved(fingerprint), false);
    assert.equal(tickets.approve({ ticket, url, password }), true);
    assert.equal(registry.isApproved(fingerprint), true);
    assert.equal(tickets.approve({ ticket, url, password }), false, "replayed ticket is rejected");
    const other = registry.fingerprint("client-B", "conversation-B");
    assert.equal(registry.isApproved(other), false, "approval cannot grant unrelated session");
    for (let i=0; i<128; i++) {
      const next = tickets.issue(other);
      if (!next.ready) { assert.equal(next.reason,"capacity"); break; }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("chat password accepts 1 UTF-8 byte and rejects empty or over-limit values", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-chat-min-password-"));
  try {
    const registry = new ChatAccessRegistry(root, owner);
    const fp = registry.fingerprint("short-password-client", "short-password-session");
    const short = new ChatApprovalTickets(root, registry, "x");
    const ticket = short.issue(fp).ticket as string;
    assert.match(ticket, /^[A-Za-z0-9_-]+$/);
    assert.equal(short.approve({ ticket, url, password: "x" }), true);
    assert.equal(registry.isApproved(fp), true);
    assert.deepEqual(new ChatApprovalTickets(root, registry, "").issue(fp),
      { ready: false, reason: "password_not_configured" });
    assert.throws(() => new ChatApprovalTickets(root, registry, "x".repeat(1025)),
      /1–1024 UTF-8 bytes/);
    assert.equal(typeof new ChatApprovalTickets(root, registry, "x".repeat(1024)).issue(fp).ticket, "string");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("approval widget contains only public HTTPS endpoint and direct fetch", () => {
  const html = chatApprovalWidget("https://devos.example");
  assert.ok(html.includes("https://devos.example/chat-access/approve"));
  assert.match(html, /type="password"/);
  assert.match(html, /Разрешить и продолжить/);
  assert.match(html, /credentials: "omit"/);
  assert.match(html, /method: "POST"/);
  assert.ok(!html.includes(owner) && !html.includes(password));
  assert.ok(!html.includes("callTool"));
  assert.ok(html.includes("sendFollowUpMessage"));
  assert.ok(html.includes('"ui/message"'));
  assert.ok(html.includes('"ui/initialize"'));
  assert.equal(CHAT_APPROVAL_WIDGET_URI, "ui://devos/chat-approval-v2.html");
  assert.ok(!html.includes("sendFollowUpMessage({ prompt: password"));
  assert.match(html, /share\/…/);
});

test("OAuth MCP app renders inline widget and approves by direct HTTPS POST, never through tool args",
  { timeout: 75_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "devos-inline-approve-gateway-"));
    const issuer = "https://widget.devos.example";
    await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    await writeFile(join(root, ".env"), "DEVOS_CHAT_ACCESS_PASSWORD=" + password + "\n", { mode: 0o600 });
    const gateway = await startGateway({ root, port: 0, ownerSecret: owner, publicUrl: issuer, oauthClientsPath: null });
    const base = "http://127.0.0.1:" + gateway.address.port;
    const client = new Client({ name: "inline-widget-test", version: "1" }, { capabilities: {} });
    let second: Client | undefined;
    try {
      const { tokens } = await oauthToken(base, owner, issuer + "/mcp");
      const auth = { Authorization: "Bearer " + tokens.access_token };
      await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { ...auth, "x-openai-session": "widget-chat-session-A" } },
      }) as Transport);
      const tools = (await client.listTools()).tools;
      const preflightTool = tools.find(t => t.name === "devos_noop");
      assert.equal((preflightTool as any)?._meta?.ui?.resourceUri, CHAT_APPROVAL_WIDGET_URI,
        "first MCP preflight should render the form directly");
      const descriptor = tools.find(t => t.name === "devos_authorize_chat");
      assert.ok(descriptor);
      assert.equal((descriptor as any)._meta?.ui?.resourceUri, CHAT_APPROVAL_WIDGET_URI);
      assert.ok(tools.some(t => t.name === "devos_noop"));
      for (const name of ["read_file", "start_process", "devos_task_status"]) {
        const tool = tools.find(t => t.name === name) as any;
        assert.ok(tool, name + " listed");
        assert.equal(tool._meta?.ui?.resourceUri, CHAT_APPROVAL_WIDGET_URI,
          "unapproved " + name + " must advertise the inline form on the first call");
        assert.equal(tool._meta?.["openai/outputTemplate"], CHAT_APPROVAL_WIDGET_URI);
      }

      const list = await client.listResources();
      assert.ok(list.resources.some(r => r.uri === CHAT_APPROVAL_WIDGET_URI));
      const read = await client.readResource({ uri: CHAT_APPROVAL_WIDGET_URI });
      const resource: any = read.contents[0];
      assert.equal(resource.mimeType, "text/html;profile=mcp-app");
      assert.deepEqual(resource._meta?.ui?.csp?.connectDomains, [issuer]);
      assert.deepEqual(resource._meta?.["openai/ui"]?.availableDisplayModes, ["inline"]);
      assert.match(resource.text, /Пароль авторизации DevOS/);
      assert.ok(!resource.text.includes(password));

      // The iPhone app may skip MCP Apps resources/read. Verify that a plain
      // HTTPS page is available independently and never embeds a password,
      // private session signal, ticket or OAuth credential in HTML.
      const external = await fetch(base + "/chat-access/form");
      assert.equal(external.status, 200);
      assert.match(external.headers.get("content-type") || "", /text\/html/);
      assert.match(external.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
      const externalHtml = await external.text();
      assert.match(externalHtml, /Ссылка на чат/);
      assert.match(externalHtml, /location.hash.slice\(1\)/);
      assert.ok(!externalHtml.includes(password));
      const initialPreflight = await client.callTool({ name: "devos_noop", arguments: {} });
      assert.equal((initialPreflight as any).structuredContent?.ready, true,
        "one safe MCP call must include widget ticket without a separate authorization tool");
      assert.match((initialPreflight.content as any[])[0].text,
        /"approval_url":"https:\/\/widget\.devos\.example\/chat-access\/form#[A-Za-z0-9_-]{32}"/);
      const blocked = await client.callTool({ name: "get_config", arguments: {} });
      assert.notEqual(blocked.isError, true, "iOS must render the approval widget instead of an MCP error");
      assert.equal((blocked as any).structuredContent?.status, "authorization_required");
      assert.equal((blocked as any).structuredContent?.operation_executed, false);
      const fallbackLink = (blocked.content as any[])[0].text;
      assert.match(fallbackLink, /https:\/\/widget\.devos\.example\/chat-access\/form#[A-Za-z0-9_-]{32}/);
      assert.ok(!fallbackLink.includes(password), "no password in tool response");
      assert.equal((blocked as any).structuredContent?.ready, true,
        "a denied operational tool should also return an approval ticket");
      assert.equal((blocked as any)._meta?.ui?.resourceUri, CHAT_APPROVAL_WIDGET_URI);
      const begin = await client.callTool({ name: "devos_authorize_chat", arguments: {} });
      assert.notEqual(begin.isError, true);
      const challenge = payload(begin) as { ready: boolean; ticket: string };
      assert.equal(challenge.ready, true);
      assert.match(challenge.ticket, /^[a-zA-Z0-9_-]+$/);
      assert.ok(!JSON.stringify(begin).includes(password));

      const preflight = await fetch(base + "/chat-access/approve", {
        method: "OPTIONS", headers: {
          Origin: "https://web-sandbox.oaiusercontent.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      const submit = (ticket: string, provided: string) => fetch(base + "/chat-access/approve", {
        method: "POST", headers: {
          Origin: "https://web-sandbox.oaiusercontent.com",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ticket, password: provided, url: mobileShareUrl }),
      });

      const invalid = await submit(challenge.ticket, "wrong-secret");
      assert.equal(invalid.status, 403);
      const granted = await submit(challenge.ticket, password);
      assert.equal(granted.status, 200);
      assert.deepEqual(await granted.json(), { approved: true });
      assert.equal(granted.headers.get("access-control-allow-origin"), "*");
      assert.equal((await submit(challenge.ticket, password)).status, 403, "no replay");

      assert.notEqual((await client.callTool({ name: "get_config", arguments: {} })).isError, true,
        "approved mobile share session can now call original Desktop Commander");
      const approvedListed = (await client.listTools()).tools as any[];
      assert.equal(approvedListed.find(t => t.name === "read_file")?._meta?.ui, undefined,
        "authorized tools must not keep displaying approval widget");
      const already = await client.callTool({ name: "devos_noop", arguments: {} });
      assert.equal((already as any).structuredContent?.approved, true);
      assert.equal((already as any).structuredContent?.reason, "already_authorized");

      second = new Client({ name: "unapproved chat", version: "1" }, { capabilities: {} });
      await second.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: { headers: { ...auth, "x-openai-session": "widget-chat-session-B" } },
      }) as Transport);
      const deniedSecond = await second.callTool({ name: "get_config", arguments: {} });
      assert.equal((deniedSecond as any).structuredContent?.status, "authorization_required");
      assert.equal((deniedSecond as any).structuredContent?.operation_executed, false);
      const ref = payload(await second.callTool({ name: "devos_authorize_chat", arguments: {} })) as any;
      assert.equal(ref.ready, true);
      assert.notEqual(ref.ticket, challenge.ticket);
      assert.equal((await submit(ref.ticket, "wrong-secret")).status, 403);
      const stillDenied = await second.callTool({ name: "get_config", arguments: {} });
      assert.equal((stillDenied as any).structuredContent?.status, "authorization_required");
      assert.equal((stillDenied as any).structuredContent?.operation_executed, false);

      const missing = new Client({ name:"missing-session", version:"1" }, {capabilities:{}});
      try {
        await missing.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp"), {
          requestInit: {headers:auth},
        }) as Transport);
        assert.deepEqual(payload(await missing.callTool({name:"devos_authorize_chat",arguments:{}})),
          {ready:false,reason:"missing_session"});
      } finally { await missing.close(); }
    } finally {
      await Promise.allSettled([client.close(), second?.close()]);
      await gateway.close();
      await rm(root, { recursive: true, force: true });
    }
  });
