import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { startGateway } from "../src/connector-gateway.js";
import { oauthToken } from "./connector-auth-fixture.js";

const ownerSecret = "session-capacity-" + randomBytes(32).toString("hex");
const issuer = "https://session-capacity.example";

async function connectClient(base: string, token: string, name: string) {
  const client = new Client({ name, version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + token },
      },
    }) as Transport,
  );
  return client;
}

test("gateway replaces the least-recently-used idle MCP session at capacity", { timeout: 60_000 }, async () => {
  const gateway = await startGateway({
    root: process.cwd(),
    port: 0,
    ownerSecret,
    publicUrl: issuer,
    oauthClientsPath: null,
  });
  const base = `http://127.0.0.1:${gateway.address.port}`;
  const clients: Client[] = [];
  try {
    const { tokens } = await oauthToken(base, ownerSecret, issuer + "/mcp");
    for (let index = 0; index < 33; index++) {
      const client = new Client(
        { name: `session-capacity-${index}`, version: "1" },
        { capabilities: {} },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
          requestInit: {
            headers: { Authorization: "Bearer " + tokens.access_token },
          },
        }) as Transport,
      );
      clients.push(client);
    }

    assert.equal(gateway.desktopSnapshot().publicSessionCount, 32);
    await assert.rejects(clients[0]!.ping(), /404|unknown_session/i);
    assert.ok((await clients.at(-1)!.listTools()).tools.length > 0);
    assert.equal(gateway.desktopSnapshot().state, "alive");
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await gateway.close();
  }
});

test("gateway never evicts a session with an active initialize or tool request", { timeout: 60_000 }, async () => {
  const gateway = await startGateway({
    root: process.cwd(),
    port: 0,
    ownerSecret,
    publicUrl: issuer,
    oauthClientsPath: null,
  });
  const base = `http://127.0.0.1:${gateway.address.port}`;
  const clients: Client[] = [];
  const originalHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;
  let heldPingCount = 0;
  let signalHeldPings!: () => void;
  let releasePings!: () => void;
  let signalPendingInitialize!: () => void;
  let releaseInitialize!: () => void;
  const heldPings = new Promise<void>((resolve) => { signalHeldPings = resolve; });
  const pendingInitialize = new Promise<void>((resolve) => { signalPendingInitialize = resolve; });
  const pingGate = new Promise<void>((resolve) => { releasePings = resolve; });
  const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
  StreamableHTTPServerTransport.prototype.handleRequest = async function (req, res, body) {
    const result = await originalHandleRequest.call(this, req, res, body);
    const message = body as { method?: string; params?: { clientInfo?: { name?: string } } };
    if (message?.method === "ping") {
      heldPingCount++;
      if (heldPingCount === 31) signalHeldPings();
      await pingGate;
    }
    if (message?.method === "initialize" && message.params?.clientInfo?.name === "pending-init") {
      signalPendingInitialize();
      await initializeGate;
    }
    return result;
  };
  try {
    const { tokens } = await oauthToken(base, ownerSecret, issuer + "/mcp");
    for (let index = 0; index < 31; index++)
      clients.push(await connectClient(base, tokens.access_token, `active-${index}`));

    const activePings = clients.map((client) => client.ping());
    await Promise.race([
      heldPings,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pings did not reach the gateway")), 5_000)),
    ]);
    assert.equal(heldPingCount, 31);

    const pendingClient = await connectClient(base, tokens.access_token, "pending-init");
    clients.push(pendingClient);
    await Promise.race([
      pendingInitialize,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("initialize response was not held")), 5_000)),
    ]);
    await assert.rejects(
      connectClient(base, tokens.access_token, "overflow"),
      /503|session_capacity/i,
    );
    assert.equal(gateway.desktopSnapshot().publicSessionCount, 32);

    releasePings();
    releaseInitialize();
    await Promise.all(activePings);
    await pendingClient.ping();
    assert.equal(gateway.desktopSnapshot().state, "alive");
  } finally {
    releasePings();
    releaseInitialize();
    StreamableHTTPServerTransport.prototype.handleRequest = originalHandleRequest;
    await Promise.allSettled(clients.map((client) => client.close()));
    await gateway.close();
  }
});
