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
import { CallToolRequestSchema } from ${JSON.stringify(sdkTypes)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdio)};
appendFileSync(${JSON.stringify(observed)}, JSON.stringify({
  pid: process.pid,
  remote: process.env.DC_REMOTE_DEVICE,
  ownerSecret: process.env.DEVOS_CONNECTOR_OWNER_SECRET,
  ngrokToken: process.env.NGROK_AUTHTOKEN,
  shell: process.env.SHELL,
  term: process.env.TERM,
  user: process.env.USER,
  logname: process.env.LOGNAME,
}) + "\\n");
const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.oninitialized = () => appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ client: server.getClientVersion() }) + "\\n");
server.setRequestHandler(ListToolsRequestSchema, async () => {
  appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ method: "tools/list" }) + "\\n");
  if (${JSON.stringify(mode)} === "list-failure") throw new Error("readiness failed");
  return { tools: [{ name: "get_config", inputSchema: { type: "object" } }] };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ call: request.params }) + "\\n");
  return { content: [{ type: "text", text: "ok" }] };
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

test("launch matches upstream environment and client identity and forwards safe remote metadata", async () => {
  const f = await fixture();
  const envKeys = [
    "DEVOS_CONNECTOR_OWNER_SECRET",
    "NGROK_AUTHTOKEN",
    "SHELL",
    "TERM",
    "USER",
    "LOGNAME",
  ];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const sentinels = {
    DEVOS_CONNECTOR_OWNER_SECRET: "owner-secret-sentinel",
    NGROK_AUTHTOKEN: "ngrok-token-sentinel",
    SHELL: "/bin/fixture-shell",
    TERM: "fixture-term",
    USER: "fixture-user",
    LOGNAME: "fixture-logname",
  };
  Object.assign(process.env, sentinels);
  const desktop = new DesktopCommanderIntegration({ root: f.root });
  try {
    await desktop.initialize();
    await desktop.callTool({
      name: "get_config",
      arguments: {},
      _meta: {
        progressToken: "request-7",
        clientInfo: { name: "remote-client", version: "4.2" },
        secret: "must-not-cross-the-adapter",
      },
    });
    const events = (await readFile(f.observed, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].remote, "true");
    assert.equal(events[0].ownerSecret, undefined);
    assert.equal(events[0].ngrokToken, undefined);
    assert.equal(events[0].shell, sentinels.SHELL);
    assert.equal(events[0].term, sentinels.TERM);
    assert.equal(events[0].user, sentinels.USER);
    assert.equal(events[0].logname, sentinels.LOGNAME);
    assert.deepEqual(events[1].client, {
      name: "desktop-commander-client",
      version: "1.0.0",
    });
    assert.deepEqual(events[3].call._meta, {
      progressToken: "request-7",
      clientInfo: { name: "remote-client", version: "4.2" },
      remote: true,
    });
    assert.ok(!JSON.stringify(events).includes("owner-secret-sentinel"));
    assert.ok(!JSON.stringify(events).includes("ngrok-token-sentinel"));
    assert.ok(!JSON.stringify(events).includes("must-not-cross-the-adapter"));
    assert.deepEqual(
      Object.fromEntries(envKeys.slice(2).map((key) => [key, events[0][key.toLowerCase()]])),
      Object.fromEntries(envKeys.slice(2).map((key) => [key, sentinels[key as keyof typeof sentinels]])),
    );
  } finally {
    await desktop.close();
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
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

test("protocol onerror is diagnostic-only and never fails a healthy backend", async () => {
  let failures = 0;
  const adapter = new DesktopCommanderIntegration({
    root: process.cwd(),
    timing: { heartbeatIntervalMs: 1_000 },
    onDisconnect: () => failures++,
  });
  try {
    await adapter.initialize();
    const client = (adapter as any).client;
    client.onerror(new Error("private protocol detail must not be retained"));
    const snapshot = adapter.snapshot();
    assert.equal(snapshot.protocolErrorCount, 1);
    assert.equal(snapshot.state, "alive");
    assert.equal(adapter.ready, true);
    assert.equal(failures, 0);
    assert.equal(JSON.stringify(snapshot).includes("private protocol detail"), false);
  } finally {
    await adapter.close();
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

test("watchdog failure captures bounded payload-free child metrics for the owned PID", async () => {
  const f = await fixture();
  const reasons: string[] = [];
  const desktop = new DesktopCommanderIntegration({
    root: f.root,
    timing: {
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 20,
      heartbeatFailureThreshold: 3,
    },
    onDisconnect: (reason) => reasons.push(reason),
  });
  let pid: number | undefined;
  try {
    await desktop.initialize();
    pid = desktop.snapshot().pid;
    assert.ok(pid);
    process.kill(pid!, "SIGSTOP");
    await waitFor(() => reasons.length === 1, 2_000);
    const snapshot = desktop.snapshot();
    assert.equal(snapshot.state, "stale/dead");
    assert.equal(snapshot.pid, pid);
    assert.ok(snapshot.processStartedAt);
    assert.ok((snapshot.rssBytes ?? 0) > 0);
    assert.ok(typeof snapshot.cpuPercent === "number");
    assert.equal(snapshot.protocolErrorCount, 0);
    assert.equal(snapshot.activeRequestCount, 0);
    assert.ok(snapshot.recentRequests.length <= 50);
    assert.ok(!JSON.stringify(snapshot).includes(f.root));
    assert.deepEqual(reasons, ["watchdog missed heartbeat threshold"]);
  } finally {
    if (pid) process.kill(pid, "SIGCONT");
    await desktop.close();
    if (pid) await waitFor(() => isDead(pid!));
    await rm(f.root, { recursive: true, force: true });
  }
});
