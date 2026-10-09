import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { chatApprovalWidget } from "../src/chat-access-widget.js";

type HostOptions = {
  standard: "supported" | "unsupported" | "denied";
  approved: boolean;
  standardOnly?: boolean;
  pendingOnCheck?: boolean;
  alreadyAuthorized?: boolean;
  noSubmit?: boolean;
};
async function exerciseHost({ standard, approved, standardOnly = false,
  pendingOnCheck = true, alreadyAuthorized = false, noSubmit = false }: HostOptions) {
  const html = chatApprovalWidget("https://devos.example");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, "inline widget JavaScript is present");
  const elements = new Map<string, any>();
  for (const id of ["message", "approval-panel", "auth", "password", "chaturl", "go"]) {
    elements.set(id, { value: "", hidden: false, disabled: false,
      textContent: "", handlers: new Map() });
  }
  elements.get("chaturl").value = "https://chatgpt.com/share/6ac864aa-fc90-83ed-8d16-91a75fb01000";
  elements.get("password").value = "test-owner-password";
  const listeners = new Map<string, (e: unknown) => void>();
  const sent: Array<Record<string, any>> = [];
  const alias: any[] = [];
  const http: any[] = [];
  const pendingRechecks: Array<{ callback: () => void; cancelled: boolean; unref: () => void }> = [];
  const vmTimeout = (callback: () => void, ms: number) => {
    if (ms === 4000) {
      const timer = { callback, cancelled: false, unref() {} };
      pendingRechecks.push(timer);
      return timer;
    }
    return setTimeout(callback, ms);
  };
  const vmClearTimeout = (timer: any) => {
    if (timer && "cancelled" in timer) timer.cancelled = true;
    else clearTimeout(timer);
  };
  let ticketStillPending = pendingOnCheck;
  let parent: { postMessage: (value: Record<string, any>) => void };
  parent = { postMessage(value) {
    sent.push(value);
    if (value.method === "ui/initialize") {
      queueMicrotask(() => listeners.get("message")?.({
        source: parent, data: standard === "unsupported"
          ? { jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "unsupported" } }
          : { jsonrpc: "2.0", id: value.id, result: { hostCapabilities: {} } },
      }));
      if (standardOnly) queueMicrotask(() => listeners.get("message")?.({
        source: parent, data: {
          jsonrpc: "2.0", method: "ui/notifications/tool-result",
          params: { structuredContent: { ready: true, ticket: "a".repeat(32) } },
        },
      }));
    }
    if (value.method === "ui/message") {
      queueMicrotask(() => listeners.get("message")?.({
        source: parent, data: standard === "denied"
          ? { jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "denied" } }
          : { jsonrpc: "2.0", id: value.id, result: {} },
      }));
    }
  } };
  const window = {
    parent,
    openai: standardOnly ? undefined : {
      toolOutput: alreadyAuthorized
        ? { approved: true, reason: "already_authorized" }
        : { ready: true, ticket: "a".repeat(32) },
      sendFollowUpMessage: async (msg: any) => { alias.push(msg); },
    },
    addEventListener(name: string, fn: (e: unknown) => void) {
      listeners.set(name, fn);
    },
  };
  const document = {
    getElementById(id: string) {
      const element = elements.get(id);
      if (!element) throw Error("Unknown element " + id);
      element.addEventListener = (name: string, fn: (...args: any[]) => void) => {
        element.handlers.set(name, fn);
      };
      return element;
    },
  };
  const fetch = async (url: string, options: any) => {
    http.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("/chat-access/check"))
      return { ok: true, json: async () => ({ pending: ticketStillPending }) };
    return { ok: approved, json: async () => ({ approved }) };
  };
  runInNewContext(script, { window, document, fetch,
    setTimeout: vmTimeout, clearTimeout: vmClearTimeout,
    Map, Promise, Error }, { timeout: 1500 });
  await new Promise<void>(resolve => setImmediate(resolve));
  const submit = elements.get("auth").handlers.get("submit");
  assert.equal(typeof submit, "function");
  if (!noSubmit) await submit({ preventDefault() {} });
  return { sent, alias, http, elements,
    expireTicket: async () => {
      ticketStillPending = false;
      const timer = pendingRechecks.find(t => !t.cancelled);
      assert.ok(timer, "pending form must schedule a self-recheck");
      timer.cancelled = true;
      timer.callback();
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

test("approved inline widget continues through standard ui/message exactly once", async () => {
  const h = await exerciseHost({ standard: "supported", approved: true });
  const messages = h.sent.filter(m => m.method === "ui/message");
  assert.equal(messages.length, 1);
  assert.equal(h.alias.length, 0, "do not use both host methods");
  assert.equal(messages[0]!.params.role, "user");
  assert.equal(messages[0]!.params.content[0].type, "text");
  assert.match(messages[0]!.params.content[0].text, /продолжи последнее/);
  assert.ok(!JSON.stringify(messages).includes("test-owner-password"));
  assert.ok(!JSON.stringify(messages).includes("one-time-ticket"));
  assert.equal(h.http.filter(v => v.url.endsWith("/chat-access/approve")).length, 1);
  assert.equal(h.http.find(v => v.url.endsWith("/chat-access/approve"))?.body.password, "test-owner-password");
  assert.equal(h.elements.get("auth").hidden, true);
});

test("legacy host uses only compatibility alias if MCP Apps initialize is unsupported", async () => {
  const h = await exerciseHost({ standard: "unsupported", approved: true });
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 0);
  assert.equal(h.alias.length, 1);
  assert.match(h.alias[0].prompt, /продолжи последнее/);
});

test("ui/message explicit rejection never retries another transport", async () => {
  const h = await exerciseHost({ standard: "denied", approved: true });
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 1);
  assert.equal(h.alias.length, 0);
  assert.match(h.elements.get("message").textContent, /не подтвердил продолжение/);
});

test("bad password never invokes the host continuation APIs", async () => {
  const h = await exerciseHost({ standard: "supported", approved: false });
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 0);
  assert.equal(h.alias.length, 0);
  assert.equal(h.elements.get("auth").hidden, false);
});

test("standard-only host can initialize and deliver widget ticket without window.openai", async () => {
  const h = await exerciseHost({ standard: "supported", approved: true, standardOnly: true });
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 1);
  assert.equal(h.alias.length, 0);
  assert.equal(h.elements.get("auth").hidden, true);
});

test("cached successful operation must never display authorization form", async () => {
  const h = await exerciseHost({
    standard: "supported", approved: true, alreadyAuthorized: true, noSubmit: true,
  });
  assert.equal(h.elements.get("approval-panel").hidden, true);
  assert.equal(h.elements.get("auth").hidden, true);
  assert.equal(h.http.filter(v => v.url.endsWith("/chat-access/check")).length, 0);
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 0);
});

test("old approval card with a consumed ticket must stay hidden", async () => {
  const h = await exerciseHost({
    standard: "supported", approved: true, pendingOnCheck: false, noSubmit: true,
  });
  assert.equal(h.elements.get("approval-panel").hidden, true);
  assert.equal(h.elements.get("auth").hidden, true);
  assert.equal(h.http.filter(v => v.url.endsWith("/chat-access/check")).length, 1);
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 0);
});

test("only an outstanding authorization ticket reveals the form", async () => {
  const h = await exerciseHost({
    standard: "supported", approved: true, pendingOnCheck: true, noSubmit: true,
  });
  assert.equal(h.elements.get("approval-panel").hidden, false);
  assert.equal(h.elements.get("auth").hidden, false);
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 0);
});

test("previously visible authorization card hides after another card approves the chat", async () => {
  const h = await exerciseHost({
    standard: "supported", approved: true, pendingOnCheck: true, noSubmit: true,
  });
  assert.equal(h.elements.get("approval-panel").hidden, false);
  await h.expireTicket();
  assert.equal(h.elements.get("approval-panel").hidden, true);
  assert.equal(h.elements.get("auth").hidden, true);
  assert.equal(h.sent.filter(m => m.method === "ui/message").length, 0,
    "an old card must not trigger another model continuation");
});
