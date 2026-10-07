import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopCommanderIntegration } from "../src/desktop-commander-integration.js";

const sdkTypes = import.meta.resolve("@modelcontextprotocol/sdk/types.js");
const sdkStdio = import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const sdkServer = import.meta.resolve("@modelcontextprotocol/sdk/server/index.js");

async function fixture(mode: "ready" | "list-failure" = "ready") {
  const root = await mkdtemp(join(tmpdir(), "devos desktop adapter "));
  const entry = join(root, "node_modules/@wonderwhy-er/desktop-commander/dist");
  await mkdir(entry, { recursive: true });
  await writeFile(
    join(root, "node_modules/@wonderwhy-er/desktop-commander/package.json"),
    JSON.stringify({ type: "module", version: "0.2.52" }),
  );
  const observed = join(root, "observed.json");
  await writeFile(
    join(entry, "index.js"),
    `
import { appendFileSync } from "node:fs";
import { Server } from ${JSON.stringify(sdkServer)};
import { ListToolsRequestSchema } from ${JSON.stringify(sdkTypes)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdio)};
appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ pid: process.pid, remote: process.env.DC_REMOTE_DEVICE }) + "\\n");
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  appendFileSync(${JSON.stringify(observed)}, "tools/list\\n");
  if (${JSON.stringify(mode)} === "list-failure") throw new Error("readiness failed");
  return { tools: [{ name: "get_config", inputSchema: { type: "object" } }] };
});
await server.connect(new StdioServerTransport());
`,
  );
  return { root, observed };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition did not become true before timeout");
}

function isDead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test("adapter readiness proves execution with tools/list", async () => {
  const f = await fixture();
  const desktop = new DesktopCommanderIntegration({ root: f.root });
  try {
    await desktop.initialize();
    assert.equal(desktop.ready, true);
    assert.equal(desktop.snapshot().state, "alive");
    assert.match(await readFile(f.observed, "utf8"), /tools\/list/);
  } finally {
    await desktop.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("unexpected child close clears readiness and reports one disconnect", async () => {
  const f = await fixture();
  const desktop = new DesktopCommanderIntegration({ root: f.root });
  const reasons: string[] = [];
  desktop.onDisconnect((reason) => reasons.push(reason));
  try {
    await desktop.initialize();
    const pid = desktop.snapshot().pid;
    assert.ok(pid);
    process.kill(pid!, "SIGKILL");
    await waitFor(() => reasons.length === 1);
    assert.equal(desktop.ready, false);
    assert.deepEqual(reasons, ["stdio transport closed"]);
  } finally {
    await desktop.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed listTools readiness closes the partial child", async () => {
  const f = await fixture("list-failure");
  const desktop = new DesktopCommanderIntegration({ root: f.root });
  let pid: number | undefined;
  try {
    await assert.rejects(desktop.initialize());
    pid = desktop.snapshot().pid;
    assert.equal(desktop.ready, false);
    assert.ok(!pid || isDead(pid), "failed initialization must not leave a child");
  } finally {
    await desktop.close();
    if (pid) await waitFor(() => isDead(pid!));
    await rm(f.root, { recursive: true, force: true });
  }
});

test("adapter close is idempotent, bounded and owns its child", async () => {
  const f = await fixture();
  const desktop = new DesktopCommanderIntegration({ root: f.root });
  let pid: number | undefined;
  try {
    await desktop.initialize();
    pid = desktop.snapshot().pid;
    assert.ok(pid);
    const outcome = await Promise.race([
      Promise.all([desktop.close(), desktop.close()]).then(() => "closed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
    ]);
    assert.equal(outcome, "closed");
    assert.ok(isDead(pid!));
    assert.equal(desktop.ready, false);
  } finally {
    await desktop.close();
    if (pid) await waitFor(() => isDead(pid!));
    await rm(f.root, { recursive: true, force: true });
  }
});
