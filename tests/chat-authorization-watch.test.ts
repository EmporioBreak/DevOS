import assert from "node:assert/strict";
import test from "node:test";
import { watchChatAccessRevocation } from "../src/chat-authorization-watch.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("revocation aborts an in-flight request and stop prevents later checks", async () => {
  let allowed = true;
  const controller = new AbortController();
  const stop = watchChatAccessRevocation(() => allowed, controller, 5);
  await pause(16);
  assert.equal(controller.signal.aborted, false);
  allowed = false;
  await pause(18);
  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason), /revoked/);
  stop();
});

test("unreadable grant state fails closed", async () => {
  const controller = new AbortController();
  const stop = watchChatAccessRevocation(() => { throw new Error("bad registry"); },
    controller, 5);
  await pause(20);
  assert.equal(controller.signal.aborted, true);
  stop();
});
