import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startGateway } from "../src/connector-gateway.js";
import { oauthToken } from "./connector-auth-fixture.js";

const ownerSecret = "notification-fixture-" + randomBytes(32).toString("hex");
const issuer = "https://notifications.example";
const sdkServer = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");
const sdkTypes = import.meta.resolve("@modelcontextprotocol/sdk/types.js");
const sdkStdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "devos notification flood "));
  const entry = join(root, "node_modules/@wonderwhy-er/desktop-commander/dist");
  await mkdir(entry, { recursive: true });
  await writeFile(
    join(root, "node_modules/@wonderwhy-er/desktop-commander/package.json"),
    JSON.stringify({ type: "module", version: "0.2.52" }),
  );
  await writeFile(
    join(entry, "index.js"),
    `
import { Server } from ${JSON.stringify(sdkServer)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkTypes)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdio)};
const server = new Server({ name: "notification-fixture", version: "1" }, { capabilities: { tools: {}, logging: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "controlled", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const count = Number(request.params.arguments?.notificationFlood ?? 0);
  for (let i = 0; i < count; i++) {
    await extra.sendNotification({ method: "notifications/message", params: { level: "info", logger: "fixture", data: "internal " + i } });
    if (i % 100 === 0 && request.params._meta?.progressToken !== undefined) {
      await extra.sendNotification({ method: "notifications/progress", params: { progress: i + 1, total: count, progressToken: request.params._meta.progressToken } });
    }
  }
  return { content: [{ type: "text", text: "done" }] };
});
await server.connect(new StdioServerTransport());
`,
  );
  return { root };
}

async function connectClient(base: string, token: string) {
  const client = new Client({ name: "public-fixture", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }) as Transport,
  );
  return client;
}

test("internal log flood stays private while progress and concurrent tool calls remain routed", async () => {
  const fixture = await createFixture();
  let backendFailures = 0;
  const gateway = await startGateway({
    root: fixture.root,
    port: 0,
    ownerSecret,
    publicUrl: issuer,
    oauthClientsPath: null,
    timing: {
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 100,
      heartbeatFailureThreshold: 3,
    },
    onFailure: () => backendFailures++,
  });
  const base = `http://127.0.0.1:${gateway.address.port}`;
  let first: Client | undefined;
  let second: Client | undefined;
  let firstLogNotifications = 0;
  let secondLogNotifications = 0;
  try {
    const { tokens } = await oauthToken(base, ownerSecret, issuer + "/mcp");
    first = await connectClient(base, tokens.access_token);
    second = await connectClient(base, tokens.access_token);
    first.setNotificationHandler(LoggingMessageNotificationSchema, () => {
      firstLogNotifications++;
    });
    second.setNotificationHandler(LoggingMessageNotificationSchema, () => {
      secondLogNotifications++;
    });

    let firstProgress = 0;
    let secondProgress = 0;
    const flood = first.callTool(
      { name: "controlled", arguments: { notificationFlood: 1_000 } },
      undefined,
      { onprogress: () => firstProgress++ },
    );
    const concurrent = second.callTool(
      { name: "controlled", arguments: {} },
      undefined,
      { onprogress: () => secondProgress++ },
    );
    const [floodResult, concurrentResult] = await Promise.all([flood, concurrent]);
    assert.match(JSON.stringify(floodResult), /done/);
    assert.match(JSON.stringify(concurrentResult), /done/);
    assert.ok(firstProgress > 0, "correlated progress reaches its requester");
    assert.equal(secondProgress, 0, "unrelated session receives no progress");
    assert.equal(firstLogNotifications, 0);
    assert.equal(secondLogNotifications, 0);
    assert.equal(backendFailures, 0);

    const snapshot = (gateway as typeof gateway & { desktopSnapshot?: () => any }).desktopSnapshot?.();
    assert.ok(snapshot, "private adapter diagnostics are available to the supervisor and tests");
    assert.equal(snapshot.notificationCounts["notifications/message"], 1_000);
    assert.ok(snapshot.activeRequestCount <= 1, "only the single-flight heartbeat may remain active");
    assert.ok(snapshot.recentRequests.length <= 50);
    assert.ok(!JSON.stringify(snapshot).includes("internal 999"));
  } finally {
    await first?.close();
    await second?.close();
    await gateway.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
