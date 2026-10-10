import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

test("JSON-only MCP SDK returns application/json without SSE", async () => {
  const app = express();
  app.use(express.json());
  const server = new McpServer({ name: "json-staging-smoke", version: "1" });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await server.connect(transport as Transport);
  app.post("/mcp", (req, res) => {
    void transport.handleRequest(req, res, req.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const received: string[] = [];
  let client: Client | undefined;
  try {
    client = new Client({ name: "smoke-client", version: "1" }, { capabilities: {} });
    const remote = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (response.status === 200 && response.headers.get("content-type"))
          received.push(response.headers.get("content-type")!);
        return response;
      },
    });
    await client.connect(remote as Transport);
    await client.ping();
    assert.ok(received.length >= 2);
    assert.ok(received.every(value => value.startsWith("application/json")),
      `unexpected response content types: ${received.join(", ")}`);
  } finally {
    await client?.close();
    await server.close();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
});
