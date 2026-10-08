import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { CHATGPT_RESPONSE_LOADER_SOURCE } from "../src/chatgpt-response-loader.js";

const answer = 'DEVOS_RESULT {"status":"done"}';
const finalMessage = { message: { author: { role: "assistant" }, channel: "final", content: { content_type: "text", parts: [answer] }, status: "finished_successfully", end_turn: true } };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function fixture(chunks: string[], linger = false) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); if (!linger) controller.close(); } });
  const window = { location: { origin: "https://chatgpt.com" }, fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) } as unknown as { fetch: typeof fetch; __DEVOS_ARM_STREAM__: () => number; __DEVOS_STREAM_STATE__: { text: string | null; failed: boolean } };
  runInNewContext(CHATGPT_RESPONSE_LOADER_SOURCE, { window, URL, TextDecoder });
  window.__DEVOS_ARM_STREAM__();
  const response = await window.fetch("https://chatgpt.com/backend-api/conversation", { method: "POST", body: JSON.stringify({ messages: [{ id: "user", author: { role: "user" } }] }) });
  try {
    const deadline = Date.now() + 150;
    while (window.__DEVOS_STREAM_STATE__.text === null && !window.__DEVOS_STREAM_STATE__.failed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    return { ...window.__DEVOS_STREAM_STATE__ };
  } finally {
    if (linger) controller.close();
    await response.text();
  }
}

test("terminal completion ignores partial trailers at every chunk boundary", async () => {
  const message = { message: { ...finalMessage.message, end_turn: false } };
  const terminal = event(message) + event({ type: "message_stream_complete" });
  const trailer = "data: [DONE]\n\n";
  for (let split = 0; split <= trailer.length; split++) {
    const state = await fixture([terminal + trailer.slice(0, split), trailer.slice(split)]);
    assert.equal(state.failed, false, `split ${split}`);
    assert.equal(state.text, answer);
  }
});

for (const terminal of [finalMessage, { type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }] } }]) {
  test(`terminal ${'type' in terminal ? terminal.type : 'final end_turn'} settles a lingering stream`, async () => {
    const state = await fixture([event(terminal)], true);
    assert.equal(state.text, answer);
    assert.equal(state.failed, false);
  });
}
for (const type of ["response.failed", "response.incomplete", "response.cancelled", "error"]) {
  test(`terminal ${type} fails promptly on lingering stream`, async () => {
    const state = await fixture([event({ type, error: { message: "failed" } })], true);
    assert.equal(state.failed, true);
    assert.equal(state.text, null);
  });
}
for (const partial of [
  { type: "response.output_text.delta", delta: answer },
  { message: { ...finalMessage.message, end_turn: false } },
  { message: { ...finalMessage.message, channel: "analysis" } },
  { message: { ...finalMessage.message, author: { role: "tool" } } },
]) {
  test(`partial/tool output cannot settle response ${JSON.stringify(partial)}`, async () => {
    const state = await fixture([event(partial)], true);
    assert.equal(state.failed, false);
    assert.equal(state.text, null);
  });
}

test("stream bytes refresh activity independently of response completion", async () => {
  let now = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const window = { location: { origin: "https://chatgpt.com" }, fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) } as unknown as { fetch: typeof fetch; __DEVOS_ARM_STREAM__: () => number; __DEVOS_STREAM_STATE__: { text: string | null; lastActivityAt: number } };
  runInNewContext(CHATGPT_RESPONSE_LOADER_SOURCE, { window, URL, TextDecoder, Date: { now: () => now } });
  window.__DEVOS_ARM_STREAM__();
  const response = await window.fetch("https://chatgpt.com/backend-api/conversation", { method: "POST", body: JSON.stringify({ messages: [{ id: "user", author: { role: "user" } }] }) });
  now = 11 * 60_000;
  controller.enqueue(new TextEncoder().encode(event({ type: "response.output_text.delta", delta: "working" })));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(window.__DEVOS_STREAM_STATE__.lastActivityAt, now);
  assert.equal(window.__DEVOS_STREAM_STATE__.text, null);
  controller.enqueue(new TextEncoder().encode(event(finalMessage)));
  controller.close();
  await response.text();
});

test("page-world submission ID is captured only for the armed exact user prompt", async () => {
  const payload = { messages: [
    { id: "tool", author: { role: "tool" }, content: { parts: ["different"] } },
    { id: "user-actual", author: { role: "user" }, content: { parts: ["exact", " prompt"] } },
  ], conversation_id: "saved" };
  const content = event(finalMessage);
  const encoder = new TextEncoder();
  const run = async (expected: string) => {
    const window = {
      location: { origin: "https://chatgpt.com" },
      fetch: async () => new Response(new ReadableStream({
        start(c) { c.enqueue(encoder.encode(content)); c.close(); },
      }), { headers: { "content-type": "text/event-stream" } }),
    } as unknown as { fetch: typeof fetch; __DEVOS_ARM_STREAM__: (prompt: string) => number;
      __DEVOS_STREAM_STATE__: { messageId: string | null; conversationId: string | null; text: string | null } };
    runInNewContext(CHATGPT_RESPONSE_LOADER_SOURCE, { window, URL, TextDecoder });
    window.__DEVOS_ARM_STREAM__(expected);
    await window.fetch("https://chatgpt.com/backend-api/conversation", { method: "POST", body: JSON.stringify(payload) });
    return { messageId: window.__DEVOS_STREAM_STATE__.messageId, conversationId: window.__DEVOS_STREAM_STATE__.conversationId };
  };
  assert.deepEqual(await run("exact prompt"), { messageId: "user-actual", conversationId: "saved" });
  assert.deepEqual(await run("different prompt"), { messageId: null, conversationId: null });
  payload.messages[1]!.content.parts = ["exact\r\n prompt  \n"];
  assert.deepEqual(await run("exact\n prompt"), { messageId: "user-actual", conversationId: "saved" }, "editor-equivalent line endings and trailing whitespace match");
  assert.deepEqual(await run("exact\n prompts"), { messageId: null, conversationId: null }, "different text remains rejected");
  assert.deepEqual(await run("exact\n  prompt"), { messageId: null, conversationId: null }, "interior double spacing cannot be invented");
  const nonce = "a".repeat(64);
  payload.messages[1]!.content.parts = ["Composer changed formatting but retained proof: ", nonce];
  assert.deepEqual(await run("Worker task\nDevOS browser attempt ID: " + nonce + "."), { messageId: "user-actual", conversationId: "saved" });
  assert.deepEqual(await run("Worker task\nDevOS browser attempt ID: " + "b".repeat(64) + "."), { messageId: null, conversationId: null });
});
