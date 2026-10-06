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
      diagnostic: "Authorization: Bearer bearer-secret https://chatgpt.com/path?access_token=access-secret&api_key=api-secret&session_token=session-secret&client_secret=client-secret&accessToken=camel-secret&session%5Ftoken=encoded-secret&auth=query-secret&utm_source=ordinary",\n      commandOutput: JSON.stringify({ token: "json-secret", nested: { api_key: "nested-secret" }, message: "ordinary" }),\n      escapedOutput: JSON.stringify({ line: JSON.stringify({ password: "escaped-secret", detail: "keep me" }) }),
    });
    debugLog("two", { password: "secret-password" });
    const lines = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].data.token, "[REDACTED]");
    assert.equal(lines[0].data.output, "ordinary repository context");
    assert.equal(
      lines[0].data.diagnostic,
      "Authorization: Bearer [REDACTED] https://chatgpt.com/path?access_token=[REDACTED]&api_key=[REDACTED]&session_token=[REDACTED]&client_secret=[REDACTED]&accessToken=[REDACTED]&session%5Ftoken=[REDACTED]&auth=[REDACTED]&utm_source=ordinary",
    );
    assert.equal(lines[1].data.password, "[REDACTED]");\n    assert.equal(lines[0].data.commandOutput.includes("json-secret"), false);\n    assert.equal(lines[0].data.commandOutput.includes("nested-secret"), false);\n    assert.equal(lines[0].data.commandOutput.includes("ordinary"), true);\n    assert.equal(lines[0].data.escapedOutput.includes("escaped-secret"), false);\n    assert.equal(lines[0].data.escapedOutput.includes("keep me"), true);
  } finally {
    if (oldDebug === undefined) delete process.env.DEVOS_DEBUG; else process.env.DEVOS_DEBUG = oldDebug;
    if (oldFile === undefined) delete process.env.DEVOS_DEBUG_FILE; else process.env.DEVOS_DEBUG_FILE = oldFile;
  }
});
