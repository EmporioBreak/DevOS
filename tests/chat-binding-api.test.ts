import assert from "node:assert/strict";
import test from "node:test";
import {
  API_BIND_CANDIDATE_DELAY_MS,
  API_BIND_LIMIT,
  API_BIND_PASSES,
  API_BIND_PASS_DELAY_MS,
  resolveCanonicalBinding,
  type CanonicalBindingClient,
} from "../src/chat-binding-api.js";

const project =
  "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/";
const token = "DEVOS_BIND_abcdefghijklmnop";

test("resolves exact canonical conversation without any chat navigation", async () => {
  const reads: string[] = [];
  const client: CanonicalBindingClient = {
    async listConversations() {
      return {
        items: [
          { id: "older-chat", update_time: 10 },
          { id: "current-chat", update_time: 20 },
        ],
      };
    },
    async hasBindingToken(id) {
      reads.push(id);
      return id === "current-chat";
    },
  };
  assert.equal(
    await resolveCanonicalBinding(client, project, token, async () => {}),
    "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635/c/current-chat",
  );
  assert.deepEqual(reads, ["current-chat"]);
});

test("caps each pass at thirty candidates and retries only a bounded number of times", async () => {
  let listCalls = 0;
  let detailCalls = 0;
  const waits: number[] = [];
  const client: CanonicalBindingClient = {
    async listConversations() {
      listCalls++;
      return {
        items: Array.from({ length: 50 }, (_, index) => ({
          id: `chat-${index}`,
          update_time: 1000 - index,
        })),
      };
    },
    async hasBindingToken() {
      detailCalls++;
      return false;
    },
  };
  await assert.rejects(
    resolveCanonicalBinding(client, project, token, async ms => {
      waits.push(ms);
    }),
    /bind_not_found/,
  );
  assert.equal(listCalls, API_BIND_PASSES);
  assert.equal(detailCalls, API_BIND_LIMIT * API_BIND_PASSES);
  assert.equal(
    waits.filter(ms => ms === API_BIND_CANDIDATE_DELAY_MS).length,
    (API_BIND_LIMIT - 1) * API_BIND_PASSES,
  );
  assert.equal(
    waits.filter(ms => ms === API_BIND_PASS_DELAY_MS).length,
    API_BIND_PASSES - 1,
  );
});

test("stops immediately when a match is found inside the 30-candidate budget", async () => {
  const reads: string[] = [];
  const client: CanonicalBindingClient = {
    async listConversations() {
      return {
        items: Array.from({ length: 40 }, (_, index) => ({
          id: `chat-${index}`,
          update_time: 1000 - index,
        })),
      };
    },
    async hasBindingToken(id) {
      reads.push(id);
      return id === "chat-4";
    },
  };
  assert.match(
    await resolveCanonicalBinding(client, project, token, async () => {}),
    /\/c\/chat-4$/,
  );
  assert.deepEqual(reads, [
    "chat-0",
    "chat-1",
    "chat-2",
    "chat-3",
    "chat-4",
  ]);
});

test("preserves project-list order when canonical timestamps are not uniformly available", async () => {
  const reads: string[] = [];
  const client: CanonicalBindingClient = {
    async listConversations() {
      return {
        items: [
          { id: "first", update_time: 10 },
          { id: "second" },
          { id: "third", update_time: 30 },
        ],
      };
    },
    async hasBindingToken(id) {
      reads.push(id);
      return id === "second";
    },
  };
  assert.match(
    await resolveCanonicalBinding(client, project, token, async () => {}),
    /\/c\/second$/,
  );
  assert.deepEqual(reads, ["first", "second"]);
});

test("rejects unsupported project list shape instead of falling back to UI traversal", async () => {
  const client: CanonicalBindingClient = {
    async listConversations() {
      return { unexpected: [] };
    },
    async hasBindingToken() {
      throw new Error("must not be called");
    },
  };
  await assert.rejects(
    resolveCanonicalBinding(client, project, token, async () => {}),
    /bind_api_list_shape_unsupported/,
  );
});
