import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  conversationIdentityFingerprint,
  extractHostConversationIdentity,
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
      subject: "header-subject",
      source: "header",
    },
  );
});

test("missing or malformed host session metadata is unresolved", () => {
  assert.equal(extractHostConversationIdentity({ method: "tools/call", params: {} }), undefined);
  assert.equal(
    extractHostConversationIdentity(
      { method: "tools/call", params: { _meta: { "openai/session": "bad\nvalue" } } },
    ),
    undefined,
  );
});

test("fingerprint is stable for one scoped conversation and isolated across conversations", () => {
  const key = Buffer.alloc(32, 7);
  const base = {
    session: "v1/session-a",
    subject: "v1/subject",
    organization: "v1/org",
    source: "meta" as const,
  };
  const same = conversationIdentityFingerprint(base, key);
  assert.equal(same, conversationIdentityFingerprint({ ...base }, key));
  assert.notEqual(
    same,
    conversationIdentityFingerprint({ ...base, session: "v1/session-b" }, key),
  );
  assert.notEqual(
    same,
    conversationIdentityFingerprint({ ...base, subject: "v1/other-user" }, key),
  );
});

test("durable registry stores only fingerprint and timestamps, never raw host ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-conversation-id-"));
  try {
    const identity = {
      session: "v1/private-session-value",
      subject: "v1/private-subject-value",
      organization: "v1/private-org-value",
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
    assert.doesNotMatch(raw, /private-session-value|private-subject-value|private-org-value/);
    const registry = JSON.parse(raw);
    assert.equal(registry.conversations.length, 1);
    assert.equal(registry.conversations[0].fingerprint, first.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
