// Real gateway + exact Desktop Commander stdio behind a fake local ngrok agent.
// No real credentials, internet listener or external exposure.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  fixture,
  fixtureSecret,
  start,
  ready,
} from "./connector-process-fixture.js";
import { oauthToken } from "./connector-auth-fixture.js";
const f = await fixture();
const proc = start(f.root, "run");
const client = new Client(
  { name: "local-smoke", version: "1" },
  { capabilities: {} },
);
try {
  await ready(proc);
  assert.match(proc.output(), /https:\/\/controlled.ngrok.example\/mcp/);
  const base = `http://127.0.0.1:${f.gatewayPort}`;
  assert.equal((await fetch(base + "/mcp", { method: "POST" })).status, 401);
  const { tokens } = await oauthToken(
    base,
    fixtureSecret,
    "https://controlled.ngrok.example/mcp",
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + tokens.access_token },
      },
    }) as Transport,
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "read_file"));
  const file = join(f.root, ".devos/connector/config.json");
  const read = await client.callTool({
    name: "read_file",
    arguments: { path: file },
  });
  assert.match(JSON.stringify(read), /gatewayPort/);
  const observed = JSON.parse(
    await readFile(join(f.root, "observed.json"), "utf8"),
  );
  assert.equal(observed.ownerPresent, false);
  assert.ok(!proc.output().includes(fixtureSecret));
  console.log(
    `Local/fake-ngrok smoke: OAuth/PKCE, ${tools.tools.length} actual Desktop Commander tools, safe file read, anonymous request denied.`,
  );
} finally {
  await client.close();
  proc.child.kill("SIGTERM");
  const result = await proc.done;
  await rm(f.root, { recursive: true, force: true });
  assert.equal(result.code, 0);
}
