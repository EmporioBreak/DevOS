import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli.js";
import * as connectorModule from "../src/connector.js";
import { adaptChatGptToolCall } from "../src/connector-gateway.js";

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

test("ngrok failure classification distinguishes rejected credentials without leaking stderr", () => {
  const raw = "authentication failed: authtoken synthetic-private-value is invalid";
  const classified = connectorModule.ngrokFailureReason(raw);
  assert.equal(classified, "ngrok credential rejected.");
  assert.ok(!classified.includes("synthetic-private-value"));
  assert.equal(
    connectorModule.ngrokFailureReason("network transport closed"),
    "ngrok exited unexpectedly.",
  );
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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
test("loopback HTTP refuses anonymous/invalid bearer, serves OAuth discovery and real stdio tools", async () => {
  const g = await gateway();
  let client: Client | undefined;
  try {
    assert.equal(g.address.address, "127.0.0.1");
    const base = "http://127.0.0.1:" + g.address.port;
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
    client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(base + "/mcp"),
      {
        requestInit: {
          headers: { Authorization: "Bearer " + tokens.access_token },
        },
      },
    );
    await client.connect(transport as Transport);
    const tools = await client.listTools();
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
  let third: Awaited<ReturnType<typeof start>> | undefined;
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

    await second.close();
    second = undefined;
    third = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    const thirdBase = "http://127.0.0.1:" + third.address.port;
    const replayAfterRestart = await fetch(thirdBase + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
        resource: issuer + "/mcp",
      }),
    });
    assert.equal(
      replayAfterRestart.status,
      400,
      "consumed refresh token stays consumed across restart",
    );
    assert.equal(
      (
        await fetch(thirdBase + "/mcp", {
          headers: { Authorization: "Bearer " + rotated.access_token },
        })
      ).status,
      401,
      "replay after restart revokes the rotated family",
    );
  } finally {
    await first?.close();
    await second?.close();
    await third?.close();
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
    assert.match(fail.output, /startup\/runtime failed/);
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
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[{name:'controlled',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema,async(req,extra)=>{
  if(req.params.arguments?.cancel){await new Promise(ok=>{extra.signal.addEventListener('abort',()=>{fs.writeFileSync(${JSON.stringify(join(root, "cancelled"))},'yes');ok();},{once:true});});}
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
      });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  })();
  const base = "http://127.0.0.1:" + g.address.port;
  const { tokens } = await oauthToken(base, secret);
  const client = new Client(
    { name: "stream-test", version: "1" },
    { capabilities: {} },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: {
          headers: { Authorization: "Bearer " + tokens.access_token },
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
    assert.match(
      (await start(f.root, "status").done).output,
      /Connector running; local gateway healthy; ngrok unavailable/,
    );
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


test("stale background PID is never accepted without project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-owner-"));
  try {
    await mkdir(join(root, ".devos/connector"), { recursive: true });
    await writeFile(
      join(root, ".devos/connector/background.json"),
      JSON.stringify({ pid: process.pid, identity: "stale-or-other-project" }),
      { mode: 0o600 },
    );
    assert.equal(await connectorModule.connectorBackgroundRunning(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connector hardening keeps recovery and credentials out of CLI argv", async () => {
  const source = await readFile(new URL("../src/connector.ts", import.meta.url), "utf8");
  const gatewaySource = await readFile(
    new URL("../src/connector-gateway.ts", import.meta.url),
    "utf8",
  );
  const runner = await readFile(new URL("../src/connector-runner.ts", import.meta.url), "utf8");
  assert.match(source, /find-generic-password/);
  assert.match(source, /add-generic-password/);
  assert.match(source, /value \+ "\\n" \+ value \+ "\\n"/);
  assert.match(gatewaySource, /Desktop Commander transport closed unexpectedly/);
  assert.match(source, /backgroundOwned/);
  assert.match(source, /atomicWrite/);
  assert.doesNotMatch(source, /\["--[^"]*(secret|token)/i);
  assert.match(runner, /const backoff = \[500, 1500, 4000\]/);
  assert.match(runner, /failureLayer/);
  assert.match(runner, /port-ownership/);
  assert.match(runner, /status: "failed"/);
});


test("unreadable OAuth state fails closed with non-secret diagnostic", async () => {
  const start = connectorModule.startGateway;
  const dir = await mkdtemp(join(tmpdir(), "devos-oauth-invalid-"));
  const clientsPath = join(dir, "clients.json");
  const statePath = join(dir, "oauth-state.enc");
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  const rotatedOwner = "synthetic-rotated-owner-" + randomBytes(32).toString("hex");
  try {
    first = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    const { tokens } = await oauthToken(
      "http://127.0.0.1:" + first.address.port,
      secret,
    );
    await first.close();
    first = undefined;

    second = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: rotatedOwner,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    const diagnostic = await readFile(join(dir, "auth-diagnostic.json"), "utf8");
    assert.match(diagnostic, /"layer":"auth"/);
    assert.match(diagnostic, /"status":"invalidated"/);
    assert.doesNotMatch(diagnostic, new RegExp(secret));
    assert.doesNotMatch(diagnostic, new RegExp(rotatedOwner));
    assert.doesNotMatch(diagnostic, new RegExp(tokens.access_token));
    assert.doesNotMatch(diagnostic, new RegExp(tokens.refresh_token));
  } finally {
    await first?.close();
    await second?.close();
    await rm(dir, { recursive: true, force: true });
  }
});


test("expired OAuth entries are durably pruned across restart", async () => {
  const start = connectorModule.startGateway;
  const dir = await mkdtemp(join(tmpdir(), "devos-oauth-prune-"));
  const clientsPath = join(dir, "clients.json");
  const statePath = join(dir, "oauth-state.enc");
  const realNow = Date.now;
  const baseNow = realNow();
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  let third: Awaited<ReturnType<typeof start>> | undefined;
  try {
    Date.now = () => baseNow;
    first = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    const { tokens } = await oauthToken(
      "http://127.0.0.1:" + first.address.port,
      secret,
    );
    await first.close();
    first = undefined;

    Date.now = () => baseNow + 25 * 3600_000;
    second = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    assert.equal(
      (
        await fetch("http://127.0.0.1:" + second.address.port + "/mcp", {
          headers: { Authorization: "Bearer " + tokens.access_token },
        })
      ).status,
      401,
    );
    await second.close();
    second = undefined;

    // Roll the synthetic clock back. If the expired entries were only pruned
    // in memory but left on disk, this restart would incorrectly resurrect them.
    Date.now = () => baseNow;
    third = await start({
      root: process.cwd(),
      port: 0,
      ownerSecret: secret,
      publicUrl: issuer,
      oauthClientsPath: clientsPath,
      oauthStatePath: statePath,
    });
    assert.equal(
      (
        await fetch("http://127.0.0.1:" + third.address.port + "/mcp", {
          headers: { Authorization: "Bearer " + tokens.access_token },
        })
      ).status,
      401,
      "expired durable access token must not resurrect after restart",
    );
  } finally {
    Date.now = realNow;
    await first?.close();
    await second?.close();
    await third?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
