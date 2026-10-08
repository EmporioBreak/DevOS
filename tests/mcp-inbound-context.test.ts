import assert from "node:assert/strict";
import test from "node:test";
import {
  inboundMcpHeaders,
  withInboundMcpHeaders,
} from "../src/mcp-inbound-context.js";

test("keeps inbound MCP headers request-local across overlapping async work", async () => {
  let releaseA!: () => void;
  let releaseB!: () => void;
  const holdA = new Promise<void>(resolve => { releaseA = resolve; });
  const holdB = new Promise<void>(resolve => { releaseB = resolve; });

  const a = withInboundMcpHeaders(
    { "x-openai-session": "session-a" },
    async () => {
      assert.equal(inboundMcpHeaders()?.["x-openai-session"], "session-a");
      await holdA;
      assert.equal(inboundMcpHeaders()?.["x-openai-session"], "session-a");
    },
  );
  const b = withInboundMcpHeaders(
    { "x-openai-session": "session-b" },
    async () => {
      assert.equal(inboundMcpHeaders()?.["x-openai-session"], "session-b");
      releaseA();
      await holdB;
      assert.equal(inboundMcpHeaders()?.["x-openai-session"], "session-b");
    },
  );

  await a;
  releaseB();
  await b;
  assert.equal(inboundMcpHeaders(), undefined);
});
