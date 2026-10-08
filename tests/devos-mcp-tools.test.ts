import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JsonStateStore } from "../src/json-state-store.js";
import { DevosToolRegistry, reportTokenHash } from "../src/mcp-tools/registry.js";
import { startGateway } from "../src/connector-gateway.js";
import { oauthToken } from "./connector-auth-fixture.js";

const task = { repo: "Example/WorkerRepo", issue: 72 };
const unpack = (r: any) => JSON.parse(r.content[0].text);

test("local DevOS tools scope reports to active turns and preserve task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-mcp-tools-"));
  const registry = new DevosToolRegistry(root);
  const store = new JsonStateStore(root, task);
  try {
    assert.deepEqual(unpack(await registry.call("devos_task_status", task)), { found: false, task });
    const token = randomBytes(32).toString("hex");
    const active = { workerId: "reviewer", turn: 2, tokenHash: reportTokenHash(token) };
    await store.save({ currentWorkerId: "reviewer", completedRuns: 2,
      sessions: { reviewer: "https://chatgpt.com/c/private-session" }, activeReport: active });
    const status = unpack(await registry.call("devos_task_status", task));
    assert.deepEqual(status, { found: true, task, worker_id: "reviewer", turn: 2,
      review_loops: 0, main_agent_review_pending: false, completion_approved: false });
    assert.ok(!JSON.stringify(status).includes("private-session"));
    const report = { ...task, worker_id: "reviewer", turn: 2, status: "changes_requested", summary: "Regression found", turn_token: token };
    const first = await registry.call("devos_worker_report", report);
    assert.equal(unpack(first).recorded, true);
    assert.deepEqual(await registry.call("devos_worker_report", report), first);
    const file = join(root, ".devos", "worker-reports",
      `${encodeURIComponent(task.repo)}-issue-${task.issue}`, `turn-2-${active.tokenHash}.json`);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")),
      { task, worker_id: "reviewer", turn: 2, status: "changes_requested", summary: "Regression found", token_hash: active.tokenHash });
    assert.equal(await registry.readReport(task, active), "changes_requested");
    assert.equal((await store.load())?.currentWorkerId, "reviewer");
    for (const bad of [
      { ...report, summary: "Different report" },
      { ...report, worker_id: "developer" },
      { ...report, turn: 3 },
      { ...report, status: "invalid" },
      { ...report, repo: "../escape" },
      { ...report, extra: 1 },
      { ...report, turn_token: randomBytes(32).toString("hex") },
    ]) assert.equal((await registry.call("devos_worker_report", bad)).isError, true);
    const secondToken = randomBytes(32).toString("hex");
    await store.save({ currentWorkerId: "developer", completedRuns: 3, sessions: {},
      activeReport: { workerId: "developer", turn: 3, tokenHash: reportTokenHash(secondToken) } });
    assert.equal((await registry.call("devos_worker_report", report)).isError, true);
    const next = await registry.call("devos_worker_report",
      { ...report, worker_id: "developer", turn: 3, status: "done", turn_token: secondToken });
    assert.equal(next.isError, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public MCP gateway merges DevOS tools with unchanged Desktop Commander", { timeout: 60_000 }, async () => {
  const secret = "test-secret-" + randomBytes(32).toString("hex");
  const issuer = "https://devos-mcp-tools.example";
  const gateway = await startGateway({ root: process.cwd(), port: 0,
    ownerSecret: secret, publicUrl: issuer, oauthClientsPath: null });
  const base = `http://127.0.0.1:${gateway.address.port}`;
  const client = new Client({ name: "devos-tool-test", version: "1" }, { capabilities: {} });
  try {
    const { tokens } = await oauthToken(base, secret, issuer + "/mcp");
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + tokens.access_token } },
    }) as Transport);
    const listed = await client.listTools();
    const names = listed.tools.map(t => t.name);
    for (const name of ["read_file", "get_config", "devos_task_status", "devos_worker_report"])
      assert.ok(names.includes(name), name + " missing");
    assert.equal(names.length, new Set(names).size, "no duplicate names");
    assert.equal(listed.tools.find(t => t.name === "devos_task_status")?.annotations?.readOnlyHint, true);
    const upstream = await client.callTool({ name: "get_config", arguments: {} });
    assert.ok(!upstream.isError, "upstream tool forwarding remains intact");
    const response = await client.callTool({ name: "devos_task_status",
      arguments: { repo: "Nobody/Nowhere", issue: 987654321 } });
    assert.deepEqual(unpack(response), { found: false, task: { repo: "Nobody/Nowhere", issue: 987654321 } });
    const invalid = await client.callTool({ name: "devos_task_status",
      arguments: { repo: "../escape", issue: 1 } });
    assert.equal(invalid.isError, true);
    assert.equal(gateway.desktopSnapshot().state, "alive");
  } finally {
    await client.close();
    await gateway.close();
  }
});
