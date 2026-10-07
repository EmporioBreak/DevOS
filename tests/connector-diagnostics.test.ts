import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendConnectorDiagnostic, connectorDiagnosticRecord } from "../src/connector-diagnostics.js";

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
