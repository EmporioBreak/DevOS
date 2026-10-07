import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  captureProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../src/process-identity.js";
import { oauthToken } from "./connector-auth-fixture.js";
import {
  dead,
  directDesktopCommanderChild,
  fixture,
  fixtureSecret,
  processIsStopped,
  ready,
  start,
  waitFor,
} from "./connector-process-fixture.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectorState(root: string) {
  try {
    return JSON.parse(
      await readFile(join(root, ".devos/connector/state.json"), "utf8"),
    ) as {
      pid?: number;
      lifecycle?: string;
      restartAttempt?: number;
      lastFailureAt?: string;
      lastFailureComponent?: string;
      publicUrl?: string;
    };
  } catch {
    return {};
  }
}

async function connectClient(base: string, accessToken: string) {
  const client = new Client(
    { name: "connector-watchdog-integration", version: "1" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    }) as Transport,
  );
  return client;
}

async function cleanStoppedOwnedProcess(
  pid: number | undefined,
  identity: ProcessIdentity | null,
) {
  if (!pid || !identity) return;
  const actual = await captureProcessIdentity(pid);
  if (!actual || !sameProcessIdentity(identity, actual)) return;
  if (processIsStopped(pid)) {
    try {
      process.kill(pid, "SIGCONT");
    } catch {}
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  try {
    await waitFor(() => dead(pid), 2_000);
  } catch {
    const current = await captureProcessIdentity(pid);
    if (current && sameProcessIdentity(identity, current)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      await waitFor(() => dead(pid), 2_000);
    }
  }
}

test(
  "SIGSTOP of the owned Desktop Commander triggers bounded supervisor recovery and a fresh MCP session",
  { timeout: 150_000 },
  async () => {
    const f = await fixture();
    const proc = start(f.root, "run");
    const base = `http://127.0.0.1:${f.gatewayPort}`;
    let client: Client | undefined;
    let ownedPid: number | undefined;
    let ownedIdentity: ProcessIdentity | null = null;
    let oldRuntimePid: number | undefined;
    let oldNgrokPid: number | undefined;
    let oldNgrokChildPid: number | undefined;
    let replacementRuntimePid: number | undefined;
    let replacementDesktopPid: number | undefined;
    let replacementNgrokPid: number | undefined;
    let replacementNgrokChildPid: number | undefined;
    try {
      await ready(proc);
      const initialState = await connectorState(f.root);
      oldRuntimePid = initialState.pid;
      assert.ok(oldRuntimePid, "supervisor state records the owned runtime PID");
      await waitFor(() => {
        ownedPid = directDesktopCommanderChild(oldRuntimePid!);
        return ownedPid !== undefined;
      });
      ownedIdentity = await captureProcessIdentity(ownedPid!);
      assert.ok(ownedIdentity, "Desktop Commander PID identity is provable");
      assert.match(ownedIdentity.commandLine ?? "", /desktop-commander\/dist\/index\.js/);
      oldNgrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as {
          pid: number;
        }
      ).pid;
      oldNgrokChildPid = Number(
        await readFile(join(f.root, "child.pid"), "utf8"),
      );

      const { tokens } = await oauthToken(
        base,
        fixtureSecret,
        "https://controlled.ngrok.example/mcp",
      );
      client = await connectClient(base, tokens.access_token);
      const initialTools = await client.listTools();
      assert.ok(initialTools.tools.some((tool) => tool.name === "read_file"));

      const health = (await (await fetch(base + "/health")).json()) as {
        backendAlive: boolean;
        lastBackendOkAt: string;
      };
      assert.equal(health.backendAlive, true);
      const nextHeartbeatAt = Date.parse(health.lastBackendOkAt) + 14_750;
      if (nextHeartbeatAt > Date.now()) await delay(nextHeartbeatAt - Date.now());

      const stoppedAt = Date.now();
      process.kill(ownedPid!, "SIGSTOP");
      assert.ok(processIsStopped(ownedPid!), "the exact owned PID remains alive but stopped");
      assert.ok(
        sameProcessIdentity(
          ownedIdentity!,
          (await captureProcessIdentity(ownedPid!))!,
        ),
        "SIGSTOP leaves the owned process and its stdio transport in place",
      );
      await delay(200);
      const stoppedState = await connectorState(f.root);
      assert.equal(stoppedState.pid, oldRuntimePid);
      assert.equal(stoppedState.lifecycle, "healthy");

      let failedState: Awaited<ReturnType<typeof connectorState>> = {};
      await waitFor(async () => {
        failedState = await connectorState(f.root);
        return (
          failedState.lifecycle === "recovering" &&
          failedState.lastFailureComponent === "desktop_commander"
        );
      }, 40_000);
      assert.ok(failedState.lastFailureAt);
      assert.ok(
        Date.parse(failedState.lastFailureAt) - stoppedAt <= 40_000,
        "three missed heartbeats are reported within the 40-second bound",
      );

      let recoveredState: Awaited<ReturnType<typeof connectorState>> = {};
      await waitFor(async () => {
        recoveredState = await connectorState(f.root);
        return (
          recoveredState.lifecycle === "healthy" &&
          !!recoveredState.pid &&
          recoveredState.pid !== oldRuntimePid
        );
      }, 15_000);
      assert.ok(recoveredState.pid);
      replacementRuntimePid = recoveredState.pid;
      await waitFor(() => dead(oldRuntimePid!), 5_000);
      await waitFor(() => dead(ownedPid!), 5_000);
      await waitFor(() => dead(oldNgrokPid!), 5_000);
      await waitFor(() => dead(oldNgrokChildPid!), 5_000);

      await assert.rejects(
        client.listTools(),
        "old HTTP MCP session must fail closed after runtime replacement",
      );
      await Promise.allSettled([client.close()]);
      client = await connectClient(base, tokens.access_token);
      const recoveredTools = await client.listTools();
      assert.ok(recoveredTools.tools.some((tool) => tool.name === "read_file"));
      const config = await client.callTool({
        name: "read_file",
        arguments: { path: join(f.root, ".devos/connector/config.json") },
      });
      assert.match(JSON.stringify(config), /gatewayPort/);

      const longCallStartedAt = Date.now();
      const longProcess = await client.callTool({
        name: "start_process",
        arguments: {
          command: `node -e 'setTimeout(() => console.log("session-output-ready"), 2500)'`,
          timeout_ms: 300,
        },
      });
      assert.ok(
        Date.now() - longCallStartedAt < 4_000,
        "long process starts as a session without holding the MCP call open",
      );
      const longProcessText = JSON.stringify(longProcess);
      const longPid = Number(longProcessText.match(/Process started with PID (\d+)/)?.[1]);
      assert.ok(Number.isInteger(longPid) && longPid > 0, longProcessText);
      assert.match(JSON.stringify(await client.callTool({
        name: "list_sessions",
        arguments: {},
      })), new RegExp(`PID: ${longPid}`));
      const output = await client.callTool({
        name: "read_process_output",
        arguments: { pid: longPid, timeout_ms: 5_000 },
      });
      assert.match(JSON.stringify(output), /session-output-ready/);
      assert.equal(
        ((await (await fetch(base + "/health")).json()) as { backendAlive: boolean })
          .backendAlive,
        true,
        "a long-running Desktop Commander process session does not fail backend health",
      );

      const newDesktopPid = directDesktopCommanderChild(recoveredState.pid);
      assert.ok(newDesktopPid, "replacement runtime owns a new Desktop Commander PID");
      assert.notEqual(newDesktopPid, ownedPid);
      replacementDesktopPid = newDesktopPid;
      replacementNgrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as {
          pid: number;
        }
      ).pid;
      replacementNgrokChildPid = Number(
        await readFile(join(f.root, "child.pid"), "utf8"),
      );
      assert.notEqual(replacementNgrokPid, oldNgrokPid);

      const runtimeBeforeDesktopKill = replacementRuntimePid;
      const desktopPidBeforeKill = replacementDesktopPid;
      const ngrokBeforeDesktopKill = replacementNgrokPid;
      const ngrokChildBeforeDesktopKill = replacementNgrokChildPid;
      process.kill(desktopPidBeforeKill!, "SIGKILL");
      await waitFor(async () => {
        const state = await connectorState(f.root);
        return state.lifecycle === "recovering" &&
          state.lastFailureComponent === "desktop_commander";
      }, 10_000);
      let finalState: Awaited<ReturnType<typeof connectorState>> = {};
      await waitFor(async () => {
        finalState = await connectorState(f.root);
        return finalState.lifecycle === "healthy" && !!finalState.pid &&
          finalState.pid !== replacementRuntimePid;
      }, 15_000);
      assert.ok(finalState.pid);
      await waitFor(() => dead(runtimeBeforeDesktopKill!), 5_000);
      await waitFor(() => dead(desktopPidBeforeKill!), 5_000);
      await waitFor(() => dead(ngrokBeforeDesktopKill!), 5_000);
      await waitFor(() => dead(ngrokChildBeforeDesktopKill!), 5_000);
      replacementRuntimePid = finalState.pid;
      replacementDesktopPid = directDesktopCommanderChild(finalState.pid);
      assert.ok(replacementDesktopPid);
      replacementNgrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as {
          pid: number;
        }
      ).pid;
      replacementNgrokChildPid = Number(
        await readFile(join(f.root, "child.pid"), "utf8"),
      );
      const postKillClient = await connectClient(base, tokens.access_token);
      try {
        const postKillTools = await postKillClient.listTools();
        assert.ok(postKillTools.tools.some((tool) => tool.name === "read_file"));
      } finally {
        await postKillClient.close();
      }

      const beforeNgrokKillPid = replacementRuntimePid;
      process.kill(replacementNgrokPid, "SIGKILL");
      await waitFor(async () => {
        const state = await connectorState(f.root);
        return state.lifecycle === "recovering" && state.lastFailureComponent === "ngrok";
      }, 10_000);
      let ngrokRecoveredState: Awaited<ReturnType<typeof connectorState>> = {};
      await waitFor(async () => {
        ngrokRecoveredState = await connectorState(f.root);
        return ngrokRecoveredState.lifecycle === "healthy" &&
          !!ngrokRecoveredState.pid && ngrokRecoveredState.pid !== beforeNgrokKillPid;
      }, 15_000);
      assert.ok(ngrokRecoveredState.pid);
      await waitFor(() => dead(beforeNgrokKillPid!), 5_000);
      await waitFor(() => dead(replacementNgrokPid!), 5_000);
      await waitFor(() => dead(replacementNgrokChildPid!), 5_000);
      replacementRuntimePid = ngrokRecoveredState.pid;
      replacementDesktopPid = directDesktopCommanderChild(ngrokRecoveredState.pid);
      assert.ok(replacementDesktopPid);
      replacementNgrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as {
          pid: number;
        }
      ).pid;
      replacementNgrokChildPid = Number(
        await readFile(join(f.root, "child.pid"), "utf8"),
      );
      const postNgrokClient = await connectClient(base, tokens.access_token);
      try {
        const postNgrokTools = await postNgrokClient.listTools();
        assert.ok(postNgrokTools.tools.some((tool) => tool.name === "read_file"));
      } finally {
        await postNgrokClient.close();
      }

      const runtimeToKill = replacementRuntimePid;
      const desktopToReplaceWithRuntime = replacementDesktopPid;
      const ngrokToReplaceWithRuntime = replacementNgrokPid;
      const ngrokChildToReplaceWithRuntime = replacementNgrokChildPid;
      process.kill(runtimeToKill, "SIGKILL");
      await waitFor(async () => {
        const state = await connectorState(f.root);
        return state.lifecycle === "recovering" && state.lastFailureComponent === "runtime";
      }, 10_000);
      let runtimeRecoveredState: Awaited<ReturnType<typeof connectorState>> = {};
      await waitFor(async () => {
        runtimeRecoveredState = await connectorState(f.root);
        return runtimeRecoveredState.lifecycle === "healthy" &&
          !!runtimeRecoveredState.pid && runtimeRecoveredState.pid !== runtimeToKill;
      }, 40_000);
      assert.ok(runtimeRecoveredState.pid);
      await waitFor(() => dead(runtimeToKill!), 5_000);
      await waitFor(() => dead(desktopToReplaceWithRuntime!), 5_000);
      await waitFor(() => dead(ngrokToReplaceWithRuntime!), 5_000);
      await waitFor(() => dead(ngrokChildToReplaceWithRuntime!), 5_000);
      replacementRuntimePid = runtimeRecoveredState.pid;
      replacementDesktopPid = directDesktopCommanderChild(runtimeRecoveredState.pid);
      assert.ok(replacementDesktopPid);
      replacementNgrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as {
          pid: number;
        }
      ).pid;
      replacementNgrokChildPid = Number(
        await readFile(join(f.root, "child.pid"), "utf8"),
      );
      const postRuntimeClient = await connectClient(base, tokens.access_token);
      try {
        const postRuntimeTools = await postRuntimeClient.listTools();
        assert.ok(postRuntimeTools.tools.some((tool) => tool.name === "read_file"));
      } finally {
        await postRuntimeClient.close();
      }
    } finally {
      await Promise.allSettled(client ? [client.close()] : []);
      await cleanStoppedOwnedProcess(ownedPid, ownedIdentity);
      proc.child.kill("SIGTERM");
      const result = await proc.done;
      for (const pid of [
        replacementRuntimePid,
        replacementDesktopPid,
        replacementNgrokPid,
        replacementNgrokChildPid,
      ]) {
        if (pid) await waitFor(() => dead(pid), 5_000);
      }
      await rm(f.root, { recursive: true, force: true });
      assert.equal(result.code, 0);
    }
  },
);
