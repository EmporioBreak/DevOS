import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { parseCliArgs } from "../src/cli.js";
import * as connectorModule from "../src/connector.js";
import { ChatAccessRegistry } from "../src/chat-access.js";
import {
  adaptChatGptToolCall,
  CONNECTOR_REQUEST_TIMEOUTS,
} from "../src/connector-gateway.js";

test("provider-neutral CLI rejects obsolete tunnel IDs and secret flags", () => {
  for (const action of ["setup", "doctor", "run", "start", "stop", "status"])
    assert.deepEqual(parseCliArgs(["connector", action]), {
      kind: "connector",
      action,
    });
  for (const args of [
    ["connector", "run", "--tunnel-id", "obsolete"],
    ["connector", "run", "--token", "secret"],
  ])
    assert.throws(() => parseCliArgs(args), /Usage/);
});
test("connector exports a loopback gateway instead of a provider runtime", () => {
  assert.equal(
    typeof (connectorModule as Record<string, unknown>).startGateway,
    "function",
  );
  assert.equal("TUNNEL_VERSION" in connectorModule, false);
});
test("connector request deadline defaults stay below the client call ceiling", () => {
  assert.deepEqual(CONNECTOR_REQUEST_TIMEOUTS, {
    serviceMs: 60_000,
    toolIdleMs: 60_000,
    toolTotalMs: 180_000,
  });
});

test("ChatGPT compatibility adapter restores rich Desktop Commander arguments", () => {
  const adapt = adaptChatGptToolCall;
  assert.deepEqual(
    adapt({
      method: "tools/call",
      params: {
        name: "set_config_value",
        arguments: { key: "telemetryEnabled", value_json: "false" },
      },
    }),
    {
      method: "tools/call",
      params: {
        name: "set_config_value",
        arguments: { key: "telemetryEnabled", value: false },
      },
    },
  );
  assert.deepEqual(
    adapt({
      method: "tools/call",
      params: {
        name: "write_pdf",
        arguments: {
          path: "/tmp/in.pdf",
          content: "[{\"type\":\"delete\",\"pageIndexes\":[0]}]",
          content_format: "operations_json",
          outputPath: "/tmp/out.pdf",
          options_json: "{\"format\":\"A4\"}",
        },
      },
    }),
    {
      method: "tools/call",
      params: {
        name: "write_pdf",
        arguments: {
          path: "/tmp/in.pdf",
          content: [{ type: "delete", pageIndexes: [0] }],
          outputPath: "/tmp/out.pdf",
          options: { format: "A4" },
        },
      },
    },
  );
  assert.deepEqual(
    adapt({
      method: "tools/call",
      params: {
        name: "edit_block",
        arguments: {
          file_path: "/tmp/book.xlsx",
          range: "Sheet1!A1:B1",
          content_json: "[[\"A\",\"B\"]]",
        },
      },
    }),
    {
      method: "tools/call",
      params: {
        name: "edit_block",
        arguments: {
          file_path: "/tmp/book.xlsx",
          range: "Sheet1!A1:B1",
          content: [["A", "B"]],
        },
      },
    },
  );
});

import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const shortDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = "synthetic-owner-secret-" + randomBytes(32).toString("hex");
const issuer = "https://connector.example";
async function gateway() {
  const start = connectorModule.startGateway;
  assert.equal(typeof start, "function", "gateway is required");
  return start({
    root: process.cwd(),
    port: 0,
    ownerSecret: secret,
    publicUrl: issuer,
    oauthClientsPath: null,
  });
}
import { oauthToken } from "./connector-auth-fixture.js";
test("gateway does not listen if tools/list readiness fails", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const originalListTools = Client.prototype.listTools;
  Client.prototype.listTools = async () => {
    throw new Error("controlled readiness failure");
  };
  let unexpectedlyStarted: Awaited<ReturnType<typeof connectorModule.startGateway>> | undefined;
  try {
    await assert.rejects(
      connectorModule
        .startGateway({ root: process.cwd(), port, ownerSecret: secret })
        .then((gateway) => {
          unexpectedlyStarted = gateway;
          throw new Error("gateway resolved before proving execution readiness");
        }),
      (error: Error & { component?: string }) =>
        error.component === "desktop_commander",
    );
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(200),
      }),
    );
  } finally {
    await unexpectedlyStarted?.close();
    Client.prototype.listTools = originalListTools;
  }
});
async function assertStartupTransportCloseIsBounded(failurePoint: "connect" | "initial-readiness") {
  const originalConnect = Client.prototype.connect;
  const originalListTools = Client.prototype.listTools;
  let transportToClose: Parameters<typeof originalConnect>[0] | undefined;
  let transportCloseForCleanup: (() => Promise<void>) | undefined;
  let transportPid: number | undefined;
  Client.prototype.connect = async function (transport, options) {
    await originalConnect.call(this, transport, options);
    transportToClose = transport;
    transportPid = (transport as unknown as { pid?: number }).pid;
    const closeTransport = transport.close.bind(transport);
    transportCloseForCleanup = closeTransport;
    transport.close = async () => {
      void closeTransport();
      await new Promise<void>(() => {});
    };
    if (failurePoint === "connect") throw new Error("controlled connect failure");
  };
  Client.prototype.listTools = async () => {
    if (failurePoint === "initial-readiness") throw new Error("controlled readiness failure");
    return { tools: [] };
  };
  try {
    const startedAt = Date.now();
    const outcome = await Promise.race([
      connectorModule.startGateway({ root: process.cwd(), port: 0, ownerSecret: secret })
        .then(async (gateway) => {
          await gateway.close();
          return "resolved";
        }, () => "rejected"),
      shortDelay(5_000).then(() => "hung"),
    ]);
    assert.equal(outcome, "rejected", `${failurePoint} cleanup must not wait forever`);
    assert.ok(Date.now() - startedAt < 5_000, "startup cleanup must have a fixed upper bound");
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.listTools = originalListTools;
    if (transportToClose) {
      transportToClose.close = transportCloseForCleanup!;
      await transportCloseForCleanup!().catch(() => {});
    }
    if (transportPid) {
      const pid = transportPid;
      await waitFor(() => dead(pid));
    }
  }
}
test("connect failure uses bounded stdio cleanup", async () => {
  await assertStartupTransportCloseIsBounded("connect");
});
test("initial readiness failure uses bounded stdio cleanup", async () => {
  await assertStartupTransportCloseIsBounded("initial-readiness");
});
test("HTTP listen failure uses bounded local-client cleanup", async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as { port: number }).port;
  const originalClose = Client.prototype.close;
  Client.prototype.close = async function (...args) {
    void originalClose.apply(this, args);
    await new Promise<void>(() => {});
  };
  try {
    const startedAt = Date.now();
    await assert.rejects(
      connectorModule.startGateway({ root: process.cwd(), port, ownerSecret: secret }),
      /Loopback gateway port unavailable/,
    );
    assert.ok(Date.now() - startedAt < 5_000, "HTTP startup cleanup must have a fixed upper bound");
  } finally {
    Client.prototype.close = originalClose;
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
test("health reports suspect after a missed heartbeat but waits for the third miss to fail", async () => {
  const originalPing = Client.prototype.ping;
  let pingCalls = 0;
  const failures: string[] = [];
  let releaseThirdMiss!: () => void;
  const thirdMissGate = new Promise<void>((resolve) => { releaseThirdMiss = resolve; });
  Client.prototype.ping = async () => {
    pingCalls++;
    // Keep the third miss in-flight so HTTP scheduling delays cannot turn
    // this into an accidental third-failure assertion.
    if (pingCalls === 3) await thirdMissGate;
    if (pingCalls > 1) throw new Error("controlled heartbeat miss");
    return {};
  };
  let g: Awaited<ReturnType<typeof connectorModule.startGateway>> | undefined;
  try {
    g = await connectorModule.startGateway({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      timing: {
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 10_000,
        heartbeatFailureThreshold: 3,
      },
      onFailure: (component) => failures.push(component),
    });
    const base = `http://127.0.0.1:${g.address.port}`;
    const deadline = Date.now() + 5_000;
    let health: { ready: boolean; backendAlive: boolean; backendState: string } | undefined;
    while (Date.now() < deadline) {
      if (pingCalls >= 2) {
        health = (await (await fetch(base + "/health")).json()) as typeof health;
        if (health?.backendState === "suspect") break;
      }
      await shortDelay(2);
    }
    assert.deepEqual(health && {
      ready: health.ready,
      backendAlive: health.backendAlive,
      backendState: health.backendState,
    }, { ready: false, backendAlive: false, backendState: "suspect" });
    assert.deepEqual(failures, [], "recovery waits for the third consecutive miss");
  } finally {
    releaseThirdMiss();
    await g?.close();
    Client.prototype.ping = originalPing;
  }
});
test("heartbeat failure racing local transport close reports one backend failure", async () => {
  const originalPing = Client.prototype.ping;
  let g: Awaited<ReturnType<typeof connectorModule.startGateway>> | undefined;
  let pingCalls = 0;
  const failures: string[] = [];
  Client.prototype.ping = async () => {
    pingCalls++;
    if (pingCalls === 1) return {};
    if (pingCalls === 3 && g?.desktopPid) {
      try {
        process.kill(g.desktopPid, "SIGKILL");
      } catch {}
    }
    throw new Error("controlled heartbeat miss");
  };
  try {
    g = await connectorModule.startGateway({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      timing: {
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 10,
        heartbeatFailureThreshold: 3,
      },
      onFailure: (component) => failures.push(component),
    });
    const desktopPid = g.desktopPid;
    assert.ok(desktopPid);
    await waitFor(() => failures.length > 0);
    assert.deepEqual(failures, ["desktop_commander"]);
    await waitFor(() => dead(desktopPid));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(failures, ["desktop_commander"]);
  } finally {
    await g?.close();
    Client.prototype.ping = originalPing;
  }
});
test("stdio transport death immediately reports stale backend state and unhealthy HTTP health", async () => {
  let failureComponent: string | undefined;
  let signalFailure!: () => void;
  const failure = new Promise<void>((resolve) => { signalFailure = resolve; });
  const g = await connectorModule.startGateway({
    root: process.cwd(),
    port: 0,
    ownerSecret: secret,
    publicUrl: issuer,
    oauthClientsPath: null,
    onFailure: (component) => {
      failureComponent = component;
      signalFailure();
    },
  });
  const desktopPid = g.desktopPid;
  assert.ok(desktopPid);
  try {
    assert.equal(g.desktopSnapshot().state, "alive");
    process.kill(desktopPid!, "SIGKILL");
    await Promise.race([
      failure,
      shortDelay(2_000).then(() => { throw new Error("onclose was not reported"); }),
    ]);
    assert.equal(failureComponent, "desktop_commander");
    assert.equal(g.desktopSnapshot().ready, false);
    assert.equal(g.desktopSnapshot().state, "stale/dead");
    const health = (await (await fetch(`http://127.0.0.1:${g.address.port}/health`)).json()) as {
      ready: boolean;
      gatewayReady: boolean;
      backendAlive: boolean;
      backendState: string;
    };
    assert.deepEqual(health, {
      ready: false,
      gatewayReady: false,
      oauthReady: true,
      backendAlive: false,
      backendState: "stale/dead",
      lastBackendOkAt: g.desktopSnapshot().lastBackendOkAt,
    });
  } finally {
    await g.close();
    if (!dead(desktopPid!)) {
      process.kill(desktopPid!, "SIGTERM");
      await waitFor(() => dead(desktopPid!), 2_000);
    }
  }
});
test("gateway close stays bounded when the local MCP client close never resolves", async () => {
  const g = await gateway();
  const desktopPid = g.desktopPid;
  assert.ok(desktopPid);
  const originalClose = Client.prototype.close;
  Client.prototype.close = async () => new Promise<void>(() => {});
  try {
    const startedAt = Date.now();
    await g.close();
    assert.ok(Date.now() - startedAt < 4_000);
  } finally {
    Client.prototype.close = originalClose;
    if (!dead(desktopPid)) {
      process.kill(desktopPid, "SIGTERM");
      await waitFor(() => dead(desktopPid), 2_000);
    }
  }
});
test("loopback HTTP refuses anonymous/invalid bearer, serves OAuth discovery and real stdio tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-gateway-chat-"));
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  const g = await connectorModule.startGateway({
    root, port: 0, ownerSecret: secret, publicUrl: issuer, oauthClientsPath: null,
  });
  let client: Client | undefined;
  try {
    assert.equal(g.address.address, "127.0.0.1");
    const base = "http://127.0.0.1:" + g.address.port;
    const health = (await (await fetch(base + "/health")).json()) as {
      ready: boolean;
      gatewayReady: boolean;
      oauthReady: boolean;
      backendAlive: boolean;
      backendState: string;
      lastBackendOkAt: string;
    };
    assert.deepEqual(
      {
        ready: health.ready,
        gatewayReady: health.gatewayReady,
        oauthReady: health.oauthReady,
        backendAlive: health.backendAlive,
        backendState: health.backendState,
      },
      {
        ready: true,
        gatewayReady: true,
        oauthReady: true,
        backendAlive: true,
        backendState: "alive",
      },
    );
    assert.ok(Number.isFinite(Date.parse(health.lastBackendOkAt)));
    assert.doesNotMatch(JSON.stringify(health), /pid|commandLine|secret|path/i);
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await fetch(base + "/mcp", {
        method,
        headers: { Authorization: "Bearer invalid" },
      });
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate")!, /resource_metadata/);
    }
    const rootProbe = await fetch(base + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 7 }),
    });
    assert.equal(rootProbe.status, 200);
    assert.deepEqual(await rootProbe.json(), {
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32600, message: "Invalid Request" },
    });

    const metadata: any = await (
      await fetch(base + "/.well-known/oauth-protected-resource/mcp")
    ).json();
    assert.equal(metadata.resource, issuer + "/mcp");
    const auth: any = await (
      await fetch(base + "/.well-known/oauth-authorization-server")
    ).json();
    assert.deepEqual(auth.code_challenge_methods_supported, ["S256"]);
    const { tokens, client: registered } = await oauthToken(base, secret);
    const chats = new ChatAccessRegistry(root, secret);
    chats.approve(chats.fingerprint(registered.client_id, "gateway-test-chat"),
      "https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
    client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(base + "/mcp"),
      {
        requestInit: {
          headers: { Authorization: "Bearer " + tokens.access_token,
            "x-openai-session": "gateway-test-chat" },
        },
      },
    );
    await client.connect(transport as Transport);
    const tools = await client.listTools();
    // The skill preference UI/API is available only after owner chat access
    // has already been approved. It never reopens the password widget.
    await mkdir(join(root, "config"), { recursive: true });
    for (const file of ["devos-skills.json", "devos-skill-policy.json",
      "devos-quality-methods.json", "devos-upstreams.lock.json",
      "devos-speckit-stage-pins.json"])
      await writeFile(join(root, "config", file),
        await readFile(join(process.cwd(), "config", file)));
    const policyTool = tools.tools.find(t => t.name === "devos_skill_policy_get") as any;
    assert.equal(policyTool?._meta?.ui?.resourceUri, "ui://devos/skill-policy-v1.html");
    assert.equal(policyTool?._meta?.["openai/widgetAccessible"],true);
    const setterDescriptor=tools.tools.find(t=>t.name==="devos_skill_policy_set") as any;
    assert.equal(setterDescriptor?._meta?.["openai/widgetAccessible"],true);
    assert.ok(tools.tools.some(t => t.name === "devos_skill_policy_set"));
    const timeline=await client.callTool({name:"devos_pipeline_status",arguments:{
      repo:"EmporioBreak/DevOS",issue:748}});
    assert.equal(timeline.isError,undefined);
    assert.equal((timeline.structuredContent as {state:string})?.state,"not_started");
    const skillDiag = await client.callTool({name:"devos_skill_diagnostics",arguments:{}});
    assert.equal(skillDiag.isError,undefined);
    assert.equal((skillDiag.structuredContent as {skills:unknown[]}).skills.length,17);
    const policy = await client.callTool({name:"devos_skill_policy_get",arguments:{}});
    assert.equal(policy.isError,undefined);
    const data = policy.structuredContent as {
      fingerprint:string;skills:Array<{id:string}>;
    };
    assert.ok(data);
    assert.match(data.fingerprint,/^[0-9a-f]{64}$/);
    assert.equal(data.skills.length,17);
    assert.doesNotMatch(JSON.stringify(policy), /authorization_required|approval_pending/);
    const ownerNotWorker=await client.callTool({name:"devos_skill_manifest",arguments:{}});
    assert.equal(ownerNotWorker.isError,true);
    assert.match(JSON.stringify(ownerNotWorker),/server-verified active DevOS worker grant/);
    const policyUpdate = await client.callTool({
      name:"devos_skill_policy_set",
      arguments:{skill_id:"superpowers-test-driven-development",
        mode:"optional",scope:"global",expected_fingerprint:data.fingerprint},
    });
    assert.equal(policyUpdate.isError,undefined);
    assert.equal((policyUpdate.structuredContent as {updated:boolean}).updated,true);
    const widget = await client.readResource({uri:"ui://devos/skill-policy-v1.html"});
    assert.match("text" in widget.contents[0]! ? widget.contents[0].text : "",
      /DevOS — навыки/);
    const resources = await client.listResources();
    assert.ok(resources.resources.some(r=>r.uri==="ui://devos/skill-policy-v1.html"));
    // An unapproved chat with the same OAuth client is not entitled to the
    // owner's preferences or the settings MCP App. This must NOT make
    // the original authorization form appear on ordinary tool results.
    const otherClient = new Client({name:"unapproved-chat",version:"1"},{capabilities:{}});
    const otherTransport = new StreamableHTTPClientTransport(new URL(base+"/mcp"),{
      requestInit:{headers:{Authorization:"Bearer "+tokens.access_token,
        "x-openai-session":"different-unapproved-chat"}},
    });
    try {
      await otherClient.connect(otherTransport as Transport);
      const otherTools = await otherClient.listTools();
      const otherPolicyTool = otherTools.tools.find(t=>t.name==="devos_skill_policy_get") as any;
      assert.equal(otherPolicyTool?._meta?.ui,undefined);
      assert.equal(otherPolicyTool?._meta?.["openai/widgetAccessible"],undefined);
      const otherResources = await otherClient.listResources();
      assert.ok(!otherResources.resources.some(r=>r.uri==="ui://devos/skill-policy-v1.html"));
      await assert.rejects(otherClient.readResource({uri:"ui://devos/skill-policy-v1.html"}));
      const deniedTimeline=await otherClient.callTool({name:"devos_pipeline_status",arguments:{
        repo:"EmporioBreak/DevOS",issue:748}});
      assert.match(JSON.stringify(deniedTimeline),/authorization_required|missing_session/);
      assert.doesNotMatch(JSON.stringify(deniedTimeline),/reviewLoops|sourceStatus|workerId/);
      const deniedDiag = await otherClient.callTool({name:"devos_skill_diagnostics",arguments:{}});
      assert.match(JSON.stringify(deniedDiag),/authorization_required|missing_session/);
      assert.doesNotMatch(JSON.stringify(deniedDiag),/sourceStatus|pinnedCommit/);
      const refused = await otherClient.callTool({name:"devos_skill_policy_get",arguments:{}});
      assert.match(JSON.stringify(refused),/authorization_required|missing_session/);
      assert.doesNotMatch(JSON.stringify(refused),/"skills":\[/);
      // Cached tool schemas are public metadata, NOT a grant. A chat
      // sharing the approved owner's OAuth client still cannot read files,
      // update Git-backed skill settings or access any task-scoped skill.
      const privateFile=join(root,"unapproved-session-must-not-write.txt");
      for(const request of [
        {name:"read_file",arguments:{path:join(root,"config","devos-skills.json")}},
        {name:"write_file",arguments:{path:privateFile,content:"BAD_SIDE_EFFECT"}},
        {name:"devos_skill_policy_set",arguments:{
          skill_id:"superpowers-test-driven-development",mode:"off",scope:"global",
          expected_fingerprint:data.fingerprint,
        }},
        {name:"devos_skill_update_preview",arguments:{
          skill_id:"superpowers-writing-plans",candidate_json:"{}",
        }},
        {name:"devos_skill_manifest",arguments:{}},
        {name:"devos_skill_search",arguments:{query:"test-driven"}},
        {name:"devos_skill_read",arguments:{
          skill_id:"superpowers-test-driven-development",resource:"SKILL.md",
        }},
        {name:"devos_task_status",arguments:{issue:4321}},
      ]) {
        const denied=await otherClient.callTool(request);
        assert.match(JSON.stringify(denied),
          /authorization_required|missing_session/,
          request.name+" must be denied in an unapproved chat");
        assert.doesNotMatch(JSON.stringify(denied),
          /BAD_SIDE_EFFECT|root-cause-tracing|SKILL.md\".*content|\"skills\":\[/);
        assert.doesNotMatch(JSON.stringify(denied),
          /openai\/outputTemplate|ui:\/\/devos\/skill-policy/,
          "ordinary denied tools must not repeat native auth forms");
      }
      await assert.rejects(readFile(privateFile,"utf8"),/ENOENT/);
      assert.equal((await readFile(join(root,"config","devos-skill-policy.json"),"utf8"))
        .includes('"mode": "off"'),false);
      const ordinary=otherTools.tools.filter(t=>[
        "read_file","write_file","devos_skill_manifest","devos_skill_read",
        "devos_skill_update_preview"].includes(t.name)) as any[];
      for(const item of ordinary){
        assert.equal(item._meta?.["openai/outputTemplate"],undefined);
        assert.equal(item._meta?.ui,undefined);
      }
    } finally {
      await otherClient.close();
    }
    assert.ok(tools.tools.some((t) => t.name === "read_file"));
    for (const requiredTool of [
      "set_config_value",
      "write_pdf",
      "edit_block",
    ]) {
      const descriptor = tools.tools.find((t) => t.name === requiredTool) as any;
      assert.ok(descriptor, `ChatGPT-compatible list must include ${requiredTool}`);
      assert.doesNotMatch(JSON.stringify(descriptor.inputSchema), /"anyOf"/);
    }
    assert.equal(
      tools.tools.some((t) => t.name === "track_ui_event"),
      false,
      "internal UI telemetry must not be model-callable",
    );
    for (const tool of tools.tools) {
      const descriptor = tool as any;
      assert.equal(typeof descriptor.title, "string");
      assert.equal(typeof descriptor.annotations?.readOnlyHint, "boolean");
      assert.equal(typeof descriptor.annotations?.destructiveHint, "boolean");
      assert.equal(typeof descriptor.annotations?.openWorldHint, "boolean");
      assert.deepEqual(
        descriptor._meta?.securitySchemes,
        [{ type: "oauth2", scopes: ["mcp:tools"] }],
        `remote tool ${tool.name} must advertise its OAuth policy`,
      );
    }
    const file = join(
      tmpdir(),
      "devos-gateway-" + randomBytes(8).toString("hex"),
    );
    try {
      await writeFile(file, "gateway-controlled-read");
      const read = await client.callTool({
        name: "read_file",
        arguments: { path: file },
      });
      assert.match(JSON.stringify(read), /gateway-controlled-read/);
    } finally {
      await rm(file, { force: true });
    }
    const session = transport.sessionId;
    assert.ok(session);
    assert.equal(
      (
        await fetch(base + "/mcp", {
          method: "GET",
          headers: {
            "Mcp-Session-Id": "unknown",
            Authorization: "Bearer " + tokens.access_token,
          },
        })
      ).status,
      404,
    );
    const second = await oauthToken(base, secret);
    assert.equal(
      (
        await fetch(base + "/mcp", {
          method: "DELETE",
          headers: {
            "Mcp-Session-Id": session!,
            Authorization: "Bearer " + second.tokens.access_token,
          },
        })
      ).status,
      403,
    );
    const refresh = () =>
      fetch(base + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: registered.client_id,
          refresh_token: tokens.refresh_token,
          resource: issuer + "/mcp",
        }),
      });
    await transport.terminateSession();
    assert.equal(
      (
        await fetch(base + "/mcp", {
          method: "DELETE",
          headers: {
            "Mcp-Session-Id": session!,
            Authorization: "Bearer " + tokens.access_token,
          },
        })
      ).status,
      404,
    );
    const rotation = await refresh();
    assert.equal(rotation.status, 200);
    const rotated: any = await rotation.json();
    assert.equal((await refresh()).status, 400);
    assert.equal(
      (
        await fetch(base + "/mcp", {
          method: "GET",
          headers: { Authorization: "Bearer " + rotated.access_token },
        })
      ).status,
      401,
      "refresh replay revokes the rotated family",
    );
  } finally {
    await client?.close();
    await g.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("approved public OAuth client and bearer state survive connector restart", async () => {
  const start = connectorModule.startGateway;
  assert.equal(typeof start, "function");
  const dir = await mkdtemp(join(tmpdir(), "devos-oauth-clients-"));
  const clientsPath = join(dir, "clients.json");
  const statePath = join(dir, "oauth-state.enc");
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  try {
    first = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    const firstBase = "http://127.0.0.1:" + first.address.port;
    const { tokens, client } = await oauthToken(firstBase, secret);
    await first.close();
    first = undefined;

    const durable = JSON.parse(await readFile(clientsPath, "utf8"));
    assert.equal(durable.version, 1);
    assert.equal(durable.clients.length, 1);
    assert.equal(durable.clients[0].client_id, client.client_id);
    assert.equal(durable.clients[0].client_secret, undefined);
    assert.deepEqual(durable.approvedClientIds, [client.client_id]);
    const encryptedState = await readFile(statePath, "utf8");
    assert.doesNotMatch(encryptedState, new RegExp(tokens.access_token));
    assert.doesNotMatch(encryptedState, new RegExp(tokens.refresh_token));

    second = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    const secondBase = "http://127.0.0.1:" + second.address.port;
    assert.notEqual(
      (
        await fetch(secondBase + "/mcp", {
          method: "GET",
          headers: { Authorization: "Bearer " + tokens.access_token },
        })
      ).status,
      401,
      "unexpired access token must remain valid across restart",
    );
    const refreshAfterRestart = await fetch(secondBase + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: issuer + "/mcp",
      }),
    });
    assert.equal(refreshAfterRestart.status, 200);
    const rotated: any = await refreshAfterRestart.json();
    assert.ok(rotated.access_token);
    assert.ok(rotated.refresh_token);
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "restart-state",
      scope: "mcp:tools offline_access",
      resource: issuer + "/mcp",
    });
    const authorize = await fetch(secondBase + "/authorize?" + params, {
      redirect: "manual",
    });
    assert.equal(authorize.status, 302);
    const callback = new URL(authorize.headers.get("location")!);
    assert.equal(callback.origin, "http://127.0.0.1:54321");
    assert.equal(callback.searchParams.get("state"), "restart-state");
    assert.ok(callback.searchParams.get("code"));
  } finally {
    await first?.close();
    await second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("gateway cannot start without strong owner auth or a valid HTTPS public identity", async () => {
  const start = connectorModule.startGateway;
  assert.equal(typeof start, "function");
  for (const options of [
    { ownerSecret: "" },
    { ownerSecret: "short" },
    { publicUrl: "http://example.org" },
    { publicUrl: "https://user:password@example.org" },
  ]) {
    await assert.rejects(
      () =>
        start({
          root: process.cwd(),
          port: 0,
          ownerSecret: secret,
          publicUrl: issuer,
          ...options,
        }),
      (e) => !String(e).includes(secret) && !String(e).includes("password"),
    );
  }
});

import {
  fixture,
  fixtureSecret,
  start,
  ready,
  waitFor,
  dead,
  directDesktopCommanderChild,
} from "./connector-process-fixture.js";
test("fake ngrok launch, HTTPS discovery, isolated secrets, duplicate and foreground cleanup", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const f = await fixture(),
      proc = start(f.root, "run");
    try {
      await ready(proc);
      assert.match(proc.output(), /https:\/\/controlled.ngrok.example\/mcp/);
      assert.ok(!proc.output().includes(fixtureSecret));
      const observed = JSON.parse(
        await readFile(join(f.root, "observed.json"), "utf8"),
      );
      assert.equal(observed.keyPresent, true);
      assert.equal(observed.ownerPresent, false);
      assert.equal(observed.debug, undefined);
      assert.ok(!JSON.stringify(observed).includes(fixtureSecret));
      assert.match(observed.config, /web_addr: 127\.0\.0\.1:/);
      assert.match(observed.args.join(" "), /--inspect=false/);
      const status = await start(f.root, "status").done;
      assert.match(
        status.output,
        /local gateway healthy; ngrok HTTPS endpoint registered/,
      );
      const duplicate = await start(f.root, "run").done;
      assert.equal(duplicate.code, 1);
      assert.match(duplicate.output, /Duplicate active connector/);
      await waitFor(async () => {
        try {
          await readFile(join(f.root, "child.armed"));
          return true;
        } catch {
          return false;
        }
      });
      proc.child.kill(signal);
      const result = await proc.done;
      assert.equal(result.code, 0);
      assert.ok(!result.output.includes(fixtureSecret));
      assert.equal(
        await readFile(join(f.root, "cleanup.marker"), "utf8"),
        "done",
        "descendant gets grace after ngrok exits",
      );
      const childPid = Number(
        await readFile(join(f.root, "child.pid"), "utf8"),
      );
      assert.ok(dead(childPid));
      assert.ok(dead(observed.pid));
      assert.match(
        (await start(f.root, "status").done).output,
        /Connector stopped/,
      );
    } finally {
      proc.child.kill("SIGTERM");
      await proc.done;
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
test("abrupt CLI death retains duplicate guard through bounded cleanup and allows same-task restart", async () => {
  const f = await fixture("stubborn"),
    proc = start(f.root, "run");
  try {
    await ready(proc);
    const state = JSON.parse(
      await readFile(join(f.root, ".devos/connector/state.json"), "utf8"),
    );
    proc.child.kill("SIGKILL");
    const duplicate = await start(f.root, "run").done;
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.output, /Duplicate active connector/);
    await proc.done;
    await waitFor(() => dead(state.pid));
    const next = start(f.root, "run");
    try {
      await ready(next);
      next.child.kill("SIGTERM");
      assert.equal((await next.done).code, 0);
    } finally {
      next.child.kill("SIGTERM");
      await next.done;
    }
  } finally {
    proc.child.kill("SIGTERM");
    await proc.done;
    await rm(f.root, { recursive: true, force: true });
  }
});
test("missing auth/runtime, stale version, integrity and early ngrok failure redact diagnostics", async () => {
  const f = await fixture("fail");
  try {
    for (const overrides of [
      { NGROK_AUTHTOKEN: "" },
      { DEVOS_CONNECTOR_OWNER_SECRET: "" },
    ]) {
      const result = await start(f.root, "run", overrides).done;
      assert.equal(result.code, 1);
      assert.ok(!result.output.includes(fixtureSecret));
      assert.match(result.output, /Missing/);
    }
    const fail = await start(f.root, "run").done;
    assert.equal(fail.code, 1);
    assert.ok(!fail.output.includes(fixtureSecret));
    assert.match(fail.output, /restart budget exhausted/);
    const failedState = JSON.parse(
      await readFile(join(f.root, ".devos/connector/state.json"), "utf8"),
    );
    assert.equal(failedState.lifecycle, "terminal_failed");
    assert.equal(failedState.restartAttempt, 5);
    assert.equal(failedState.lastFailureComponent, "ngrok");
    assert.ok(!JSON.stringify(failedState).includes(fixtureSecret));
    assert.match((await start(f.root, "status").done).output, /Connector terminal_failed/);

    const failedScript = await readFile(f.binary, "utf8");
    const recoveredScript = failedScript.replace(
      `if("fail"==='fail'){process.exit(2);}`,
      `if("normal"==='fail'){process.exit(2);}`,
    );
    assert.notEqual(recoveredScript, failedScript, "fixture failure mode can be cleared for manual recovery");
    await writeFile(f.binary, recoveredScript);
    const pinnedBinary = JSON.parse(await readFile(f.binary + ".json", "utf8")) as { version: string };
    await writeFile(
      f.binary + ".json",
      JSON.stringify({
        version: pinnedBinary.version,
        sha256: createHash("sha256").update(recoveredScript).digest("hex"),
      }),
    );
    const manualRestart = start(f.root, "start");
    await waitFor(() => manualRestart.output().includes("DevOS background ready:"), 45_000);
    assert.equal((await manualRestart.done).code, 0);
    const runningState = JSON.parse(
      await readFile(join(f.root, ".devos/connector/state.json"), "utf8"),
    ) as { pid: number; lifecycle: string; restartAttempt: number };
    assert.equal(runningState.lifecycle, "healthy");
    assert.equal(runningState.restartAttempt, 0);
    const background = JSON.parse(
      await readFile(join(f.root, ".devos/connector/background.json"), "utf8"),
    ) as { pid: number };
    const desktopPid = directDesktopCommanderChild(runningState.pid);
    assert.ok(desktopPid);
    const ngrokPid = (JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as { pid: number }).pid;
    const ngrokChildPid = Number(await readFile(join(f.root, "child.pid"), "utf8"));
    assert.equal((await start(f.root, "stop").done).code, 0);
    await waitFor(() => dead(background.pid));
    await waitFor(() => dead(runningState.pid));
    await waitFor(() => dead(desktopPid!));
    await waitFor(() => dead(ngrokPid));
    await waitFor(() => dead(ngrokChildPid));

    await writeFile(
      join(f.root, ".devos/connector/config.json"),
      JSON.stringify({ password: secret }),
    );
    const invalid = await start(f.root, "doctor").done;
    assert.equal(invalid.code, 1);
    assert.ok(!invalid.output.includes(secret));
    await rm(join(f.root, ".devos/connector/config.json"));
    await writeFile(
      f.binary,
      `#!${process.execPath}\nconsole.log('ngrok version stale');`,
    );
    assert.match(
      (await start(f.root, "doctor").done).output,
      /Missing\/stale ngrok/,
    );
    await writeFile(
      f.binary,
      `#!${process.execPath}\nconsole.log('ngrok version ${connectorModule.NGROK_VERSION}');`,
    );
    assert.match(
      (await start(f.root, "doctor").done).output,
      /integrity check failed/,
    );
    await rm(f.binary);
    assert.match(
      (await start(f.root, "doctor").done).output,
      /Missing\/stale ngrok/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("config accepts only non-secret ports and exact local Desktop Commander stays pinned", () => {
  const config = connectorModule.connectorConfig;
  assert.deepEqual(config({}), { gatewayPort: 8787, ngrokApiPort: 4041 });
  for (const bad of [
    { secret },
    { gatewayPort: 0 },
    { gatewayPort: 4041 },
    { ngrokApiPort: 1 },
    { version: 2 },
  ])
    assert.throws(
      () => config(bad),
      (e) => !String(e).includes(secret),
    );
  assert.deepEqual(connectorModule.desktopCommand("/local with spaces"), {
    file: process.execPath,
    args: [
      "/local with spaces/node_modules/@wonderwhy-er/desktop-commander/dist/index.js",
      "--no-onboarding",
    ],
  });
});

test("stdio proxy preserves streaming progress tokens, tool errors and cancellation with secret-free child env", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos stdio "));
  let backendFailures = 0;
  const entry = join(root, "node_modules/@wonderwhy-er/desktop-commander/dist");
  await mkdir(entry, { recursive: true });
  await writeFile(
    join(entry, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(entry, "index.js"),
    `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(join(root, "env.json"))},JSON.stringify(process.env));
const server=new Server({name:'controlled-stdio',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async(_req,extra)=>{
  if(fs.existsSync(${JSON.stringify(join(root, "hang-list"))})) await new Promise(ok=>extra.signal.addEventListener('abort',()=>{fs.writeFileSync(${JSON.stringify(join(root, "list-cancelled"))},'yes');ok();},{once:true}));
  return {tools:[{name:'controlled',inputSchema:{type:'object'}}]};
});
server.setRequestHandler(CallToolRequestSchema,async(req,extra)=>{
  if(req.params.arguments?.cancel){await new Promise(ok=>{extra.signal.addEventListener('abort',()=>{fs.writeFileSync(${JSON.stringify(join(root, "cancelled"))},'yes');ok();},{once:true});});}
  if(req.params.arguments?.hang){await new Promise(ok=>{extra.signal.addEventListener('abort',()=>{fs.writeFileSync(${JSON.stringify(join(root, "call-cancelled"))},'yes');ok();},{once:true});});}
  if(req.params.arguments?.slowProgress){for(let i=0;i<2;i++){await new Promise(ok=>setTimeout(ok,30));await extra.sendNotification({method:'notifications/progress',params:{progressToken:req.params._meta?.progressToken,progress:i+1,total:2}});}}
  if(req.params.arguments?.progressForever){while(!extra.signal.aborted){await new Promise(ok=>setTimeout(ok,20));if(!extra.signal.aborted)await extra.sendNotification({method:'notifications/progress',params:{progressToken:req.params._meta?.progressToken,progress:1}});}}
  if(req.params._meta?.progressToken!==undefined) await extra.sendNotification({method:'notifications/progress',params:{progressToken:req.params._meta.progressToken,progress:1,total:2}});
  return {isError:!!req.params.arguments?.error,content:[{type:'text',text:'controlled tool result'}]};
});
await server.connect(new StdioServerTransport());
`,
  );
  const g = await (async () => {
    const keys = [
      "NGROK_AUTHTOKEN",
      "DEVOS_CONNECTOR_OWNER_SECRET",
      "DEVOS_DEBUG",
    ];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    for (const key of keys) process.env[key] = secret;
    try {
      return await connectorModule.startGateway({
        root,
        port: 0,
        ownerSecret: secret,
        publicUrl: issuer,
        timing: {
          heartbeatIntervalMs: 1_000,
          heartbeatTimeoutMs: 50,
          heartbeatFailureThreshold: 3,
        },
        requestTimeouts: { serviceMs: 150, toolIdleMs: 150, toolTotalMs: 220 },
        onFailure: () => backendFailures++,
      });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  })();
  const base = "http://127.0.0.1:" + g.address.port;
  const { tokens, client: oauthClient } = await oauthToken(base, secret);
  const chats = new ChatAccessRegistry(root, secret);
  chats.approve(chats.fingerprint(oauthClient.client_id, "stream-test-chat"),
    "https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
  const client = new Client(
    { name: "stream-test", version: "1" },
    { capabilities: {} },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + tokens.access_token,
            "x-openai-session": "stream-test-chat" },
        },
      }) as Transport,
    );
    const observed = JSON.parse(await readFile(join(root, "env.json"), "utf8"));
    assert.equal(observed.NGROK_AUTHTOKEN, undefined);
    assert.equal(observed.DEVOS_CONNECTOR_OWNER_SECRET, undefined);
    assert.equal(observed.DEVOS_DEBUG, undefined);
    assert.ok(!JSON.stringify(observed).includes(secret));
    let progress = 0;
    const result = await client.callTool(
      { name: "controlled", arguments: { error: true } },
      undefined,
      {
        onprogress: () => {
          progress++;
        },
      },
    );
    assert.equal(result.isError, true);
    assert.equal(
      progress,
      1,
      "SSE progress reaches the requesting remote client",
    );
    const abort = new AbortController();
    const cancelled = client.callTool(
      { name: "controlled", arguments: { cancel: true } },
      undefined,
      { signal: abort.signal },
    );
    setTimeout(() => abort.abort(), 150);
    await assert.rejects(cancelled);
    await waitFor(async () => {
      try {
        await readFile(join(root, "cancelled"));
        return true;
      } catch {
        return false;
      }
    });
    const afterCancel = await client.callTool({ name: "controlled", arguments: {} });
    assert.match(JSON.stringify(afterCancel), /controlled tool result/);

    const concurrentAbort = new AbortController();
    const pending = client.callTool(
      { name: "controlled", arguments: { hang: true } },
      undefined,
      { signal: concurrentAbort.signal },
    );
    const quick = await client.callTool({ name: "controlled", arguments: {} });
    assert.match(JSON.stringify(quick), /controlled tool result/);
    concurrentAbort.abort();
    await assert.rejects(pending);
    await waitFor(async () => {
      try {
        await readFile(join(root, "call-cancelled"));
        return true;
      } catch {
        return false;
      }
    });
    await rm(join(root, "call-cancelled"), { force: true });

    await writeFile(join(root, "hang-list"), "yes");
    const listAbort = new AbortController();
    const listResult = client.listTools(undefined, { signal: listAbort.signal });
    const listSettled = await Promise.race([
      listResult.then(() => true, () => true),
      shortDelay(250).then(() => false),
    ]);
    if (!listSettled) listAbort.abort();
    assert.equal(listSettled, true, "service request obeys its short test deadline");
    await rm(join(root, "hang-list"), { force: true });
    await waitFor(async () => {
      try {
        await readFile(join(root, "list-cancelled"));
        return true;
      } catch {
        return false;
      }
    });
    const concurrentLists = await Promise.all([
      client.listTools(),
      client.listTools(),
    ]);
    assert.ok(concurrentLists.every((list) =>
      list.tools.some((tool) => tool.name === "controlled") &&
      list.tools.some((tool) => tool.name === "devos_task_status") &&
      list.tools.some((tool) => tool.name === "devos_worker_report")
    ), "both concurrent listings preserve the upstream tool and include DevOS tools");

    let progressCount = 0;
    const slowProgress = await client.callTool(
      { name: "controlled", arguments: { slowProgress: true } },
      undefined,
      { onprogress: () => progressCount++ },
    );
    assert.match(JSON.stringify(slowProgress), /controlled tool result/);
    assert.ok(progressCount >= 2, `progress keeps the idle deadline alive (received ${progressCount})`);

    const idleTimed = client.callTool({
      name: "controlled",
      arguments: { hang: true },
    });
    const quickDuringTimeout = await client.callTool({
      name: "controlled",
      arguments: {},
    });
    assert.match(JSON.stringify(quickDuringTimeout), /controlled tool result/);
    await assert.rejects(idleTimed);
    await waitFor(async () => {
      try {
        await readFile(join(root, "call-cancelled"));
        return true;
      } catch {
        return false;
      }
    });

    const forever = new AbortController();
    const foreverResult = client.callTool(
      { name: "controlled", arguments: { progressForever: true } },
      undefined,
      { signal: forever.signal, onprogress: () => {} },
    );
    const totalDeadline = await Promise.race([
      foreverResult.then(() => true, () => true),
      shortDelay(250).then(() => false),
    ]);
    if (!totalDeadline) forever.abort();
    assert.equal(totalDeadline, true, "continuous progress cannot exceed absolute deadline");
    const afterTimeout = await client.callTool({ name: "controlled", arguments: {} });
    assert.match(JSON.stringify(afterTimeout), /controlled tool result/);
    assert.ok(g.desktopSnapshot().recentRequests.some((event) =>
      event.method === "tools/call" && event.status === "timeout"));
    assert.ok(g.desktopSnapshot().recentRequests.some((event) =>
      event.method === "tools/call" && event.status === "cancelled"),
      JSON.stringify(g.desktopSnapshot().recentRequests));
    assert.equal(backendFailures, 0, "request-local failures do not fail the backend");
    const health = (await (await fetch(base + "/health")).json()) as {
      backendAlive: boolean;
    };
    assert.equal(health.backendAlive, true);
    const originalPing = Client.prototype.ping;
    let releaseLateHeartbeat: (() => void) | undefined;
    Client.prototype.ping = async () =>
      new Promise((_, reject) => {
        releaseLateHeartbeat = () => reject(new Error("late heartbeat completion"));
      });
    try {
      const pendingCloseCall = client.callTool({
        name: "controlled",
        arguments: { hang: true },
      });
      const pendingCloseOutcome = pendingCloseCall.then(
        () => "resolved",
        () => "rejected",
      );
      await waitFor(() => releaseLateHeartbeat !== undefined);
      const firstClose = g.close();
      const secondClose = g.close();
      const closed = await Promise.race([
        Promise.all([firstClose, secondClose]).then(() => true),
        shortDelay(5_000).then(() => false),
      ]);
      assert.equal(closed, true, "concurrent gateway close calls settle boundedly");
      const requestOutcome = await Promise.race([
        pendingCloseOutcome,
        shortDelay(500).then(() => "timeout"),
      ]);
      assert.equal(requestOutcome, "rejected", "shutdown settles pending MCP calls promptly");
      releaseLateHeartbeat?.();
      await shortDelay(30);
      assert.equal(backendFailures, 0, "late heartbeat cannot fail a closed gateway");
    } finally {
      Client.prototype.ping = originalPing;
    }
  } finally {
    await client.close();
    await g.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SIGTERM during startup performs bounded graceful cancellation", async () => {
  const f = await fixture("slow"),
    proc = start(f.root, "run");
  try {
    await waitFor(async () => {
      try {
        await readFile(join(f.root, "observed.json"));
        return true;
      } catch {
        return false;
      }
    });
    const before = Date.now();
    proc.child.kill("SIGTERM");
    const result = await proc.done;
    assert.equal(
      result.code,
      0,
      "requested startup cancellation is a normal shutdown",
    );
    assert.ok(Date.now() - before < 6000);
  } finally {
    proc.child.kill("SIGTERM");
    await proc.done;
    await rm(f.root, { recursive: true, force: true });
  }
});

test("confidential OAuth registration requires its secret and supports token revocation", async () => {
  const g = await gateway();
  try {
    const base = `http://127.0.0.1:${g.address.port}`;
    const { tokens, client } = await oauthToken(
      base,
      secret,
      issuer + "/mcp",
      "client_secret_post",
    );
    assert.ok(client.client_secret);
    const revoke = await fetch(base + "/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        token: tokens.refresh_token,
      }),
    });
    assert.equal(revoke.status, 200);
    assert.equal(
      (
        await fetch(base + "/mcp", {
          headers: { Authorization: "Bearer " + tokens.access_token },
        })
      ).status,
      401,
    );
    const registration = await fetch(base + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://untrusted.example/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 400);
    const maliciousOrigin = await fetch(base + "/consent", {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ticket: "invalid", secret }),
    });
    assert.equal(maliciousOrigin.status, 403);
    assert.ok(!(await maliciousOrigin.text()).includes(secret));
  } finally {
    await g.close();
  }
});

test("gateway stays closed before public HTTPS identity is ready", async () => {
  const g = await connectorModule.startGateway({
    root: process.cwd(),
    port: 0,
    ownerSecret: secret,
  });
  try {
    const base = `http://127.0.0.1:${g.address.port}`;
    assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 503);
    assert.equal(
      ((await (await fetch(base + "/health")).json()) as { ready: boolean })
        .ready,
      false,
    );
    g.setPublicUrl(issuer);
    assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 401);
  } finally {
    await g.close();
  }
});


test("background ownership rejects PID reuse and project mismatch", () => {
  const identity = { pid: 123, startTime: "start", executable: "/usr/bin/node" };
  assert.equal(connectorModule.backgroundOwnershipMatches(
    { pid: 123, projectRoot: "/project", identity },
    identity,
    "/project",
  ), true);
  assert.equal(connectorModule.backgroundOwnershipMatches(
    { pid: 123, projectRoot: "/project", identity },
    { ...identity, startTime: "later" },
    "/project",
  ), false);
  assert.equal(connectorModule.backgroundOwnershipMatches(
    { pid: 123, projectRoot: "/other", identity },
    identity,
    "/project",
  ), false);
});


test("connector status distinguishes recovery and terminal failure", () => {
  assert.equal(
    connectorModule.formatConnectorStatus({
      lifecycle: "recovering",
      supervisor: "owned",
      runtimeAlive: false,
      localHealthy: false,
      ngrokRegistered: false,
      restartAttempt: 3,
      maxRestartAttempts: 5,
      lastFailureComponent: "ngrok",
      lastExitCode: 1,
      lastFailureAt: "2026-10-07T00:00:00.000Z",
    }),
    "Connector recovering; supervisor owned; runtime stopped; local gateway unavailable; ngrok unavailable; restart 3/5; last failure ngrok exit=1 at 2026-10-07T00:00:00.000Z; public reachability not tested.\n",
  );
  assert.equal(
    connectorModule.formatConnectorStatus({
      lifecycle: "terminal_failed",
      supervisor: "foreground-or-absent",
      runtimeAlive: false,
      localHealthy: false,
      ngrokRegistered: false,
      restartAttempt: 5,
      maxRestartAttempts: 5,
      lastFailureComponent: "desktop_commander",
    }),
    "Connector terminal_failed; supervisor foreground-or-absent; runtime stopped; local gateway unavailable; ngrok unavailable; restart 5/5; last failure desktop_commander; public reachability not tested.\n",
  );
});


test("live connector ownership without identity is ambiguous, not stale", () => {
  assert.equal(
    connectorModule.backgroundOwnershipIsProvable(
      { pid: 123, projectRoot: "/project" },
      "/project",
    ),
    false,
  );
  assert.equal(
    connectorModule.backgroundOwnershipIsProvable(
      {
        pid: 123,
        projectRoot: "/project",
        identity: {
          pid: 123,
          startTime: "start",
          executable: "/usr/bin/node",
          commandLine: "node connector-runner.js /project --background",
        },
      },
      "/project",
    ),
    true,
  );
});


test("cloudflare staging tunnel config and URL validation are fail-closed", () => {
  assert.deepEqual(connectorModule.connectorConfig({ gatewayPort: 8788, ngrokApiPort: 4042, tunnel: "cloudflare" }), {
    gatewayPort: 8788, ngrokApiPort: 4042, tunnel: "cloudflare",
  });
  assert.deepEqual(connectorModule.connectorConfig({}), {
    gatewayPort: 8787, ngrokApiPort: 4041,
  });
  for (const tunnel of ["", "foo", "trycloudflare.com", null])
    assert.throws(() => connectorModule.connectorConfig({ tunnel }));
  assert.equal(connectorModule.cloudflareQuickTunnelUrl(
    "2026-10-09 INF | https://test-stage-123.trycloudflare.com | OK"
  ), "https://test-stage-123.trycloudflare.com/");
  for (const log of [
    "https://evil.tld",
    "https://test-stage-123.trycloudflare.com.evil.tld",
    "https://trycloudflare.com",
    "no public endpoint",
  ]) assert.equal(connectorModule.cloudflareQuickTunnelUrl(log), undefined);
  assert.match(connectorModule.formatConnectorStatus({
    lifecycle: "healthy", supervisor: "owned", runtimeAlive: true,
    localHealthy: true, ngrokRegistered: true, tunnel: "cloudflare",
  }), /cloudflare HTTPS endpoint registered/);
});
