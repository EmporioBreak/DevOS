import assert from "node:assert/strict";
import test from "node:test";
import { waitForWorkerGrant } from "../src/connector-gateway.js";

test("worker grant wait refuses to start without a verified pending probe", async () => {
  const controller = new AbortController();
  let checked = false;
  const result = await waitForWorkerGrant(() => false, () => { checked = true; return true; }, controller.signal, 10);
  assert.equal(result, false);
  assert.equal(checked, false, "a probe hint alone must not trigger grant checks or authorization");
});

test("worker grant wait times out and stops promptly when the HTTP request aborts", async () => {
  const timeout = await waitForWorkerGrant(() => true, () => false, new AbortController().signal, 20);
  assert.equal(timeout, false);

  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForWorkerGrant(() => true, () => false, controller.signal, 5_000);
  setTimeout(() => controller.abort(), 10);
  assert.equal(await waiting, false);
  assert.ok(Date.now() - started < 500, "client abort cancels the wait promptly");
});

test("worker grant wait returns only after the independent grant predicate succeeds", async () => {
  const controller = new AbortController();
  let granted = false;
  const waiting = waitForWorkerGrant(() => true, () => granted, controller.signal, 1_000);
  setTimeout(() => { granted = true; }, 20);
  assert.equal(await waiting, true);
});


test("an already-qualified worker wait survives probe consumption before grant", async () => {
  const controller = new AbortController();
  const signedPendingWasVerified = true;
  let nonceStillExists = true;
  let signedGrant = false;
  const wait = waitForWorkerGrant(
    () => signedPendingWasVerified,
    () => signedGrant,
    controller.signal,
    1_000,
  );
  nonceStillExists = false; // trusted observer consumed the signed challenge
  assert.equal(nonceStillExists, false);
  setTimeout(() => { signedGrant = true; }, 15);
  assert.equal(await wait, true, "only the subsequently committed independent grant authorizes");
});
