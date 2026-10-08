import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  conversationIdentityFingerprint,
  extractHostConversationIdentity,
  observeSuccessfulToolConversationIdentity,
  recordHostConversationIdentity,
} from "../src/conversation-identity.js";

test("prefers documented openai/session metadata over transport headers", () => {
  const identity = extractHostConversationIdentity(
    {
      method: "tools/call",
      params: {
        _meta: {
          "openai/session": "v1/session-meta",
          "openai/subject": "v1/subject-meta",
          "openai/organization": "v1/org-meta",
        },
      },
    },
    {
      "x-openai-session": "header-session",
      "x-openai-subject": "header-subject",
    },
  );

  assert.deepEqual(identity, {
    session: "v1/session-meta",
    subject: "v1/subject-meta",
    organization: "v1/org-meta",
    source: "meta",
  });
});

test("uses x-openai-session only as compatibility fallback", () => {
  assert.deepEqual(
    extractHostConversationIdentity(
      { method: "tools/call", params: { _meta: {} } },
      {
        "x-openai-session": "header-session",
        "x-openai-subject": "header-subject",
      },
    ),
    {
      session: "header-session",
      source: "header",
    },
  );
});

test("missing, malformed, or conflicting host session metadata is unresolved", () => {
  assert.equal(extractHostConversationIdentity({ method: "tools/call", params: {} }), undefined);
  assert.equal(
    extractHostConversationIdentity(
      { method: "tools/call", params: { _meta: { "openai/session": "bad\nvalue" } } },
      { "x-openai-session": "header-session" },
    ),
    undefined,
  );
  assert.equal(
    extractHostConversationIdentity(
      { method: "tools/call", params: { _meta: { "openai/session": "meta-session" } } },
      { "x-openai-session": "different-header-session" },
    ),
    undefined,
  );
});

test("fingerprint is stable for one host session and isolated across conversations", () => {
  const key = Buffer.alloc(32, 7);
  const base = {
    session: "v1/session-a",
    source: "meta" as const,
  };
  const same = conversationIdentityFingerprint(base, key);
  assert.equal(same, conversationIdentityFingerprint({ ...base }, key));
  assert.equal(
    same,
    conversationIdentityFingerprint({
      session: base.session,
      source: "header",
    }, key),
  );
  assert.notEqual(
    same,
    conversationIdentityFingerprint({ ...base, session: "v1/session-b" }, key),
  );
});

test("durable registry stores only fingerprint and timestamps, never raw host ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-conversation-id-"));
  try {
    const identity = {
      session: "v1/private-session-value",
      source: "meta" as const,
    };
    const first = await recordHostConversationIdentity(
      root,
      identity,
      new Date("2026-10-08T10:00:00.000Z"),
    );
    const second = await recordHostConversationIdentity(
      root,
      identity,
      new Date("2026-10-08T10:05:00.000Z"),
    );
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(second.firstSeenAt, "2026-10-08T10:00:00.000Z");
    assert.equal(second.lastSeenAt, "2026-10-08T10:05:00.000Z");

    const raw = await readFile(join(root, ".devos", "conversation-identities.json"), "utf8");
    assert.doesNotMatch(raw, /private-session-value/);
    const registry = JSON.parse(raw);
    assert.equal(registry.conversations.length, 1);
    assert.equal(registry.conversations[0].fingerprint, first.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("concurrent identity writes do not lose conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-conversation-race-"));
  try {
    await Promise.all([
      recordHostConversationIdentity(root, {
        session: "v1/session-a",
        source: "meta",
      }, new Date("2026-10-08T10:00:00.000Z")),
      recordHostConversationIdentity(root, {
        session: "v1/session-b",
        source: "meta",
      }, new Date("2026-10-08T10:00:01.000Z")),
    ]);
    const raw = await readFile(join(root, ".devos", "conversation-identities.json"), "utf8");
    const registry = JSON.parse(raw);
    assert.equal(registry.conversations.length, 2);
    assert.notEqual(
      registry.conversations[0].fingerprint,
      registry.conversations[1].fingerprint,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("tool observation records only successful calls with proven host session identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-conversation-observe-"));
  try {
    const request = {
      method: "tools/call",
      params: { _meta: { "openai/session": "v1/session-observed" } },
    };
    const recorded = await observeSuccessfulToolConversationIdentity(
      root,
      request,
      { content: [{ type: "text", text: "ok" }] },
      undefined,
      new Date("2026-10-08T11:00:00.000Z"),
    );
    assert.equal(recorded.status, "recorded");

    const unresolved = await observeSuccessfulToolConversationIdentity(
      root,
      { method: "tools/call", params: {} },
      { content: [{ type: "text", text: "ok" }] },
    );
    assert.deepEqual(unresolved, { status: "unresolved" });

    const failed = await observeSuccessfulToolConversationIdentity(
      root,
      request,
      { isError: true, content: [{ type: "text", text: "failed" }] },
    );
    assert.deepEqual(failed, { status: "tool_error" });

    const raw = await readFile(join(root, ".devos", "conversation-identities.json"), "utf8");
    const registry = JSON.parse(raw);
    assert.equal(registry.conversations.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
