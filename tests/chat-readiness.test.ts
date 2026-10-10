import assert from "node:assert/strict";
import test from "node:test";
import { waitForStableReadiness, type ReadinessSnapshot } from "../src/chat-readiness.js";

const ready: ReadinessSnapshot = {
  conversationMatches: true,
  projectMatches: true,
  composerEnabled: true,
  sendVisible: true,
  sendEnabled: true,
  generating: false,
  blockingOverlay: false,
};

test("waits through busy observations and releases only after stable enabled readiness", async () => {
  const observations = [
    { ...ready, generating: true },
    { ...ready, sendEnabled: false },
    ready,
    ready,
  ];
  const seen: string[] = [];
  const result = await waitForStableReadiness(async () => {
    const next = observations.shift() ?? ready;
    seen.push(JSON.stringify(next));
    return next;
  }, { timeoutMs: 100, intervalMs: 1, stableSamples: 2 });
  assert.deepEqual(result, ready);
  assert.equal(seen.length, 4);
});

test("times out without treating a visible disabled send control as ready", async () => {
  await assert.rejects(waitForStableReadiness(async () => ({ ...ready, sendEnabled: false }), {
    timeoutMs: 5, intervalMs: 1, stableSamples: 2,
  }), /chat did not become stably ready/i);
});

test("blocks mismatched conversation, active generation, and overlays", async () => {
  for (const blocked of [
    { ...ready, conversationMatches: false },
    { ...ready, generating: true },
    { ...ready, blockingOverlay: true },
    { ...ready, composerEnabled: false },
    { ...ready, projectMatches: false },
  ]) {
    await assert.rejects(waitForStableReadiness(async () => blocked, {
      timeoutMs: 4, intervalMs: 1, stableSamples: 2,
    }), /chat did not become stably ready/i);
  }
});

test("bounds a readiness observation that never settles", async () => {
  const started = Date.now();
  await assert.rejects(waitForStableReadiness(() => new Promise<ReadinessSnapshot>(() => {}), {
    timeoutMs: 15, intervalMs: 1, stableSamples: 2,
  }), /readiness observation exceeded its bounded deadline/i);
  assert.ok(Date.now() - started < 250);
});
