import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_BINDING_ARGUMENT,
  addChatBindingTokenToTool,
  conversationContainsChatBindingToken,
  createChatBindingToken,
  stripChatBindingTokenFromCall,
} from "../src/chat-binding-protocol.js";

const token = "DEVOS_BIND_abcdefghijklmnop";

test("creates bounded binding tokens", () => {
  assert.match(createChatBindingToken(), /^DEVOS_BIND_[a-f0-9]{32}$/);
});

test("adds one required const token field without changing existing tool fields", () => {
  const tool = {
    name: "read_file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  };
  const decorated = addChatBindingTokenToTool(tool, token) as any;
  assert.equal(decorated.name, "read_file");
  assert.deepEqual(decorated.inputSchema.required, ["path", CHAT_BINDING_ARGUMENT]);
  assert.deepEqual(decorated.inputSchema.properties.path, { type: "string" });
  assert.equal(decorated.inputSchema.properties[CHAT_BINDING_ARGUMENT].const, token);
  assert.equal(decorated.inputSchema.properties[CHAT_BINDING_ARGUMENT].default, token);
  assert.equal((tool.inputSchema.properties as any)[CHAT_BINDING_ARGUMENT], undefined);
});

test("rejects an upstream tool that already owns the internal field", () => {
  assert.throws(
    () => addChatBindingTokenToTool({
      name: "bad",
      inputSchema: {
        type: "object",
        properties: { [CHAT_BINDING_ARGUMENT]: { type: "string" } },
      },
    }, token),
    /conflicts/,
  );
});

test("validates and strips the token before forwarding tools/call", () => {
  const input = {
    method: "tools/call",
    params: {
      name: "read_file",
      arguments: { path: "/tmp/a", [CHAT_BINDING_ARGUMENT]: token },
    },
  };
  assert.deepEqual(stripChatBindingTokenFromCall(input, token), {
    method: "tools/call",
    params: {
      name: "read_file",
      arguments: { path: "/tmp/a" },
    },
  });
  assert.throws(
    () => stripChatBindingTokenFromCall({
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "/tmp/a" } },
    }, token),
    /bind_token_missing_or_mismatched/,
  );
  assert.throws(
    () => stripChatBindingTokenFromCall({
      method: "tools/call",
      params: {
        name: "read_file",
        arguments: {
          path: "/tmp/a",
          [CHAT_BINDING_ARGUMENT]: "DEVOS_BIND_wrongwrongwrong",
        },
      },
    }, token),
    /bind_token_missing_or_mismatched/,
  );
});

test("canonical evidence requires the exact internal arg on an api_tool request", () => {
  const call = {
    author: { role: "assistant" },
    recipient: "api_tool.call_tool",
    content: {
      content_type: "code",
      text: JSON.stringify({
        path: "/connector/read_file",
        args: { path: "/tmp/a", [CHAT_BINDING_ARGUMENT]: token },
      }),
    },
  };
  assert.equal(conversationContainsChatBindingToken({ messages: [call] }, token), true);

  const userMention = {
    author: { role: "user" },
    recipient: "all",
    content: { content_type: "text", parts: [token] },
  };
  const toolOutput = {
    author: { role: "tool" },
    recipient: "all",
    content: { content_type: "text", parts: [token] },
  };
  const wrongArg = {
    ...call,
    content: {
      content_type: "code",
      text: JSON.stringify({ path: "/connector/read_file", args: { note: token } }),
    },
  };
  assert.equal(
    conversationContainsChatBindingToken(
      { messages: [userMention, toolOutput, wrongArg] },
      token,
    ),
    false,
  );
});
