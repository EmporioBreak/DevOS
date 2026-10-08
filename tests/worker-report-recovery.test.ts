import assert from "node:assert/strict";
import test from "node:test";
import { readCompletedTurn } from "../src/chatgpt-turn-recovery.js";

test("recovery only relaxes textual marker validation for an explicitly MCP-enabled turn", () => {
  const data = {
    conversation_id: "conversation-1",
    mapping: {
      userNode: {
        parent: null,
        message: { id: "user-1", author: { role: "user" }, metadata: {} },
      },
      finalNode: {
        parent: "userNode",
        message: {
          id: "assistant-1",
          author: { role: "assistant" },
          channel: "final",
          status: "finished_successfully",
          end_turn: true,
          content: { content_type: "text", parts: ["Finished without a text marker."] },
        },
      },
    },
  };
  assert.throws(() => readCompletedTurn(data, "conversation-1", { messageId: "user-1" }), /DEVOS_RESULT/);
  assert.equal(readCompletedTurn(data, "conversation-1", { messageId: "user-1" }, true),
    "Finished without a text marker.");
});
