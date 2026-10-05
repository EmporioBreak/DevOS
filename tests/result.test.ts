import assert from "node:assert/strict";
import test from "node:test";
import { parseDevosResult } from "../src/result.js";

test("parses the final control line", () => {
  assert.deepEqual(
    parseDevosResult('Work completed.\nDEVOS_RESULT {"status":"done"}\n'),
    { status: "done" },
  );
});

test("accepts host fallback status", () => {
  assert.deepEqual(
    parseDevosResult('DEVOS_RESULT {"status":"needs_host"}'),
    { status: "needs_host" },
  );
});

test("rejects worker-controlled next routing", () => {
  assert.throws(
    () => parseDevosResult('DEVOS_RESULT {"status":"changes_requested","next":"developer"}'),
    /unsupported fields/,
  );
});

test("rejects output without final marker", () => {
  assert.throws(
    () => parseDevosResult('DEVOS_RESULT {"status":"done"}\nextra'),
    /did not end/,
  );
});
