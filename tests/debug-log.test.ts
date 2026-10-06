import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { debugLog } from "../src/debug-log.js";

test("DEVOS_DEBUG writes task-local append-only JSONL with credential redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-debug-"));
  const file = join(root, ".devos", "debug", "task.jsonl");
  const oldDebug = process.env.DEVOS_DEBUG;
  const oldFile = process.env.DEVOS_DEBUG_FILE;
  try {
    process.env.DEVOS_DEBUG = "1";
    process.env.DEVOS_DEBUG_FILE = file;
    debugLog("one", {
      path: "/project",
      token: "secret-token",
      output: "ordinary repository context",
      diagnostic: "Authorization: Bearer bearer-secret https://chatgpt.com/path?auth=query-secret&next=ok",
    });
    debugLog("two", { password: "secret-password" });
    const lines = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].data.token, "[REDACTED]");
    assert.equal(lines[0].data.output, "ordinary repository context");
    assert.equal(
      lines[0].data.diagnostic,
      "Authorization: Bearer [REDACTED] https://chatgpt.com/path?auth=[REDACTED]&next=ok",
    );
    assert.equal(lines[1].data.password, "[REDACTED]");
  } finally {
    if (oldDebug === undefined) delete process.env.DEVOS_DEBUG; else process.env.DEVOS_DEBUG = oldDebug;
    if (oldFile === undefined) delete process.env.DEVOS_DEBUG_FILE; else process.env.DEVOS_DEBUG_FILE = oldFile;
  }
});
