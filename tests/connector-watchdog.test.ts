import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorWatchdog } from "../src/connector-watchdog.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(2);
  assert.ok(predicate(), "condition did not become true before timeout");
}

test("watchdog starts healthy from the gateway's successful initial ping", async () => {
  const initialSuccessAt = Date.now() - 123;
  const watchdog = createConnectorWatchdog({
    ping: async () => {},
    onFailure: () => assert.fail("unexpected failure"),
    initialSuccessAt,
    intervalMs: 1_000,
  });

  try {
    assert.deepEqual(watchdog.snapshot(), {
      state: "alive",
      lastBackendOkAt: new Date(initialSuccessAt).toISOString(),
      consecutiveMisses: 0,
    });
  } finally {
    await watchdog.stop();
  }
});

test("watchdog counts consecutive misses, resets on success, and reports failure once", async () => {
  let attempts = 0;
  let failures = 0;
  const watchdog = createConnectorWatchdog({
    ping: async () => {
      attempts++;
      if (attempts === 2) return;
      throw new Error("ping missed");
    },
    onFailure: () => failures++,
    initialSuccessAt: Date.now(),
    intervalMs: 8,
    timeoutMs: 17,
    failureThreshold: 3,
  });

  try {
    await waitFor(() => attempts >= 1);
    assert.equal(failures, 0, "one miss must not fail the backend");
    await waitFor(() => attempts >= 2);
    assert.equal(watchdog.snapshot().consecutiveMisses, 0);
    assert.equal(watchdog.snapshot().state, "alive");
    await waitFor(() => failures === 1);
    await delay(30);
    assert.equal(attempts, 5, "watchdog stops scheduling after threshold");
    assert.equal(failures, 1, "failure callback is single-shot");
    assert.equal(watchdog.snapshot().state, "stale/dead");
  } finally {
    await watchdog.stop();
  }
});

test("heartbeat attempts use the configured timeout and never overlap", async () => {
  const starts: number[] = [];
  const timeouts: number[] = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const watchdog = createConnectorWatchdog({
    ping: async (timeoutMs) => {
      starts.push(Date.now());
      timeouts.push(timeoutMs);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (starts.length === 1) await first;
      } finally {
        active--;
      }
    },
    onFailure: () => assert.fail("unexpected failure"),
    initialSuccessAt: Date.now(),
    intervalMs: 15,
    timeoutMs: 23,
  });

  try {
    await waitFor(() => starts.length === 1);
    await delay(40);
    assert.equal(starts.length, 1, "an unresolved ping blocks the next attempt");
    releaseFirst();
    await waitFor(() => starts.length >= 2);
    assert.ok(starts[1]! - starts[0]! >= 14, "attempt cadence is start-to-start");
    assert.deepEqual(timeouts.slice(0, 2), [23, 23]);
    assert.equal(maxActive, 1);
  } finally {
    releaseFirst();
    await watchdog.stop();
  }
});
