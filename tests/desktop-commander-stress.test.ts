import assert from "node:assert/strict";
import test from "node:test";
import { DesktopCommanderIntegration } from "../src/desktop-commander-integration.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail("condition did not become true before timeout");
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test("pinned Desktop Commander remains stable under repeated and concurrent MCP load", { timeout: 90_000 }, async () => {
  const desktop = new DesktopCommanderIntegration({ root: process.cwd() });
  let pid: number | undefined;
  try {
    await desktop.initialize();
    pid = desktop.snapshot().pid;
    assert.ok(pid, "adapter records the owned Desktop Commander PID");

    const discovered = await desktop.listTools();
    assert.ok(discovered.tools.some((tool) => tool.name === "get_config"));

    // Compare the upstream-style direct adapter path under the same request
    // load used by the public gateway: repeated discovery/config reads and
    // concurrent read calls. The public path receives the same load in the
    // process-level integration proof.
    for (let i = 0; i < 100; i++) {
      const [tools, config] = await Promise.all([
        desktop.listTools(),
        desktop.callTool({ name: "get_config", arguments: {} }),
      ]);
      assert.ok(tools.tools.length > 0);
      assert.notEqual(config.isError, true);
    }

    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => desktop.callTool({ name: "get_config", arguments: {} })),
    );
    assert.ok(concurrent.every((result) => !result.isError));

    for (let i = 0; i < 3; i++) {
      const started = await desktop.callTool({
        name: "start_process",
        arguments: {
          command: `node -e 'setTimeout(() => console.log("stress-session-${i}"), 100)'`,
          timeout_ms: 1_000,
        },
      });
      const text = JSON.stringify(started);
      const childPid = Number(text.match(/Process started with PID (\d+)/)?.[1]);
      assert.ok(Number.isInteger(childPid) && childPid > 0, text);
      const output = await desktop.callTool({
        name: "read_process_output",
        arguments: { pid: childPid, timeout_ms: 3_000 },
      });
      assert.match(JSON.stringify(output), new RegExp(`stress-session-${i}`));
      await waitFor(() => isDead(childPid));
    }

    await delay(250);
    const snapshot = desktop.snapshot();
    assert.equal(snapshot.state, "alive");
    assert.equal(snapshot.activeRequestCount, 0);
    assert.ok(snapshot.recentRequests.length <= 50);
    assert.ok(snapshot.recentRequests.every((event) => !JSON.stringify(event).includes("stress-session")));
  } finally {
    await desktop.close();
    if (pid) await waitFor(() => isDead(pid!), 5_000);
  }
});
