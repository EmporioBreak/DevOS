import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendConnectorDiagnostic, appendDesktopCommanderDiagnostic, connectorDiagnosticRecord, desktopCommanderDiagnosticRecord } from "../src/connector-diagnostics.js";

test("connector diagnostics allow-list lifecycle fields only", () => {
  const record = connectorDiagnosticRecord({
    status: "recovering",
    restartAttempt: 2,
    maxRestartAttempts: 5,
    lastFailureAt: "2026-10-07T00:00:00.000Z",
    lastFailureComponent: "runtime",
    lastExitCode: 1,
    lastFailureMessage: "runtime exited",
  });
  assert.equal(record.status, "recovering");
  assert.equal(record.restartAttempt, 2);
  assert.equal("token" in record, false);
  assert.equal("request" in record, false);
});

test("connector diagnostic file stays bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-diag-"));
  try {
    for (let i = 0; i < 4000; i++) {
      await appendConnectorDiagnostic(root, {
        status: "recovering",
        restartAttempt: i % 5,
        maxRestartAttempts: 5,
        lastFailureMessage: "x".repeat(120),
      });
    }
    const text = await readFile(join(root, ".devos", "logs", "connector.jsonl"), "utf8");
    assert.ok(Buffer.byteLength(text) <= 256 * 1024);
    assert.match(text, /"status":"recovering"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop Commander diagnostics are payload-free, bounded, and persisted", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-dc-diag-"));
  const input = {
    reason: "watchdog missed heartbeat threshold",
    runtimePid: 123,
    publicSessionCount: 2,
    activeForwardedRequestCount: 1,
    snapshot: {
      state: "stale" as const,
      consecutiveMisses: 3,
      lastBackendOkAt: "2026-10-07T00:00:00.000Z",
      pid: 456,
      processStartedAt: "2026-10-07T00:00:00.000Z",
      activeRequestCount: 1,
      protocolErrorCount: 4,
      rssBytes: 1024,
      cpuPercent: 2,
      notificationCounts: { "notifications/message": 1000 },
      recentRequests: Array.from({ length: 70 }, (_, i) => ({
        timestamp: "2026-10-07T00:00:00.000Z",
        method: "tools/call",
        durationMs: i,
        status: "timeout",
        secretPayload: "must-not-persist",
      })),
      secret: "must-not-persist",
    },
    token: "must-not-persist",
  } as any;
  try {
    const record = desktopCommanderDiagnosticRecord(input);
    assert.equal(record.backend.recentRequests.length, 50);
    assert.equal(JSON.stringify(record).includes("must-not-persist"), false);
    await appendDesktopCommanderDiagnostic(root, input);
    const text = await readFile(join(root, ".devos", "logs", "connector.jsonl"), "utf8");
    assert.match(text, /desktop_commander_disconnect/);
    assert.equal(text.includes("must-not-persist"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
