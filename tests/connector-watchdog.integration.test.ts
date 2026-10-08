import assert from "node:assert/strict";
import test from "node:test";
import { readFile, realpath, rm } from "node:fs/promises";
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
import { ChatAccessRegistry } from "../src/chat-access.js";
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
        headers: { "x-openai-session": "watchdog-test-chat", Authorization: `Bearer ${accessToken}` },
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
  "background supervisor death disconnects and cleans its owned runtime tree",
  { timeout: 90_000 },
  async () => {
    const f = await fixture();
    let runtimeToClean: number | undefined;
    let runnerToClean: number | undefined;
    try {
      const firstStart = start(f.root, "start");
      await waitFor(() => firstStart.output().includes("DevOS background ready:"), 45_000);
      assert.equal((await firstStart.done).code, 0);
      const firstBackground = JSON.parse(
        await readFile(join(f.root, ".devos/connector/background.json"), "utf8"),
      ) as { pid: number; identity: ProcessIdentity; projectRoot: string };
      const firstState = await connectorState(f.root);
      runnerToClean = firstBackground.pid;
      runtimeToClean = firstState.pid;
      assert.equal(firstBackground.projectRoot, await realpath(f.root));
      assert.ok(runtimeToClean);
      const runnerIdentity = await captureProcessIdentity(runnerToClean);
      assert.ok(runnerIdentity && sameProcessIdentity(firstBackground.identity, runnerIdentity));
      assert.match(runnerIdentity.commandLine ?? "", /connector-runner\.js/);
      const runtimeIdentity = await captureProcessIdentity(runtimeToClean!);
      assert.ok(runtimeIdentity);
      assert.match(runtimeIdentity.commandLine ?? "", /connector-runtime\.js/);
      const desktopPid = directDesktopCommanderChild(runtimeToClean!);
      assert.ok(desktopPid);
      const ngrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as { pid: number }
      ).pid;
      const ngrokChildPid = Number(await readFile(join(f.root, "child.pid"), "utf8"));
      const ngrokIdentity = await captureProcessIdentity(ngrokPid);
      assert.ok(ngrokIdentity);
      assert.match(ngrokIdentity.commandLine ?? "", /\.devos\/tools\/ngrok/);

      process.kill(runnerToClean, "SIGKILL");
      await waitFor(() => dead(runnerToClean!), 10_000);
      await waitFor(() => dead(runtimeToClean!), 10_000);
      await waitFor(() => dead(desktopPid!), 10_000);
      await waitFor(() => dead(ngrokPid), 10_000);
      await waitFor(() => dead(ngrokChildPid), 10_000);

      const secondStart = start(f.root, "start");
      await waitFor(() => secondStart.output().includes("DevOS background ready:"), 45_000);
      assert.equal((await secondStart.done).code, 0);
      const secondBackground = JSON.parse(
        await readFile(join(f.root, ".devos/connector/background.json"), "utf8"),
      ) as { pid: number; identity: ProcessIdentity };
      let secondState = await connectorState(f.root);
      await waitFor(async () => {
        secondState = await connectorState(f.root);
        return secondState.lifecycle === "healthy" && !!secondState.pid && secondState.pid !== runtimeToClean;
      }, 10_000);
      assert.notEqual(secondBackground.pid, runnerToClean);
      const secondRuntimePid = secondState.pid!;
      const secondDesktopPid = directDesktopCommanderChild(secondRuntimePid);
      assert.ok(secondDesktopPid);
      const secondNgrokPid = (
        JSON.parse(await readFile(join(f.root, "observed.json"), "utf8")) as { pid: number }
      ).pid;
      const secondNgrokChildPid = Number(await readFile(join(f.root, "child.pid"), "utf8"));
      assert.equal((await start(f.root, "stop").done).code, 0);
      await waitFor(() => dead(secondBackground.pid), 10_000);
      await waitFor(() => dead(secondRuntimePid), 10_000);
      await waitFor(() => dead(secondDesktopPid!), 10_000);
      await waitFor(() => dead(secondNgrokPid), 10_000);
      await waitFor(() => dead(secondNgrokChildPid), 10_000);
    } finally {
      await start(f.root, "stop").done;
      if (runnerToClean) await waitFor(() => dead(runnerToClean!), 10_000).catch(() => {});
      if (runtimeToClean) await waitFor(() => dead(runtimeToClean!), 10_000).catch(() => {});
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

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

      const { tokens, client: oauthClient } = await oauthToken(
        base,
        fixtureSecret,
        "https://controlled.ngrok.example/mcp",
      );
      const chats = new ChatAccessRegistry(f.root, fixtureSecret);
      chats.approve(chats.fingerprint(oauthClient.client_id, "watchdog-test-chat"),
        "https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
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
      try {
        await waitFor(async () => {
          failedState = await connectorState(f.root);
          return (
            failedState.lifecycle === "recovering" &&
            failedState.lastFailureComponent === "desktop_commander"
          );
        }, 40_000);
      } catch {
        const health = await fetch(base + "/health")
          .then((response) => response.json())
          .catch((error) => String(error));
        assert.fail(`SIGSTOP was not detected; state=${JSON.stringify(await connectorState(f.root))}; health=${JSON.stringify(health)}`);
      }
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

      const configTool = recoveredTools.tools.find((tool) => tool.name === "get_config");
      assert.ok(configTool, "recovered public session exposes get_config");
      const expectedChat = chats.fingerprint(oauthClient.client_id, "watchdog-test-chat");
      assert.equal(chats.isApproved(expectedChat), true, "approved grant survives runtime restart");
      const noop = JSON.parse(((await client.callTool({ name: "devos_noop", arguments: {} }))
        .content as Array<{ text: string }>)[0]!.text);
      assert.equal(noop.chat_reference, expectedChat, "recovered runtime uses the same OAuth-client and session fingerprint");
      assert.equal(noop.approved, true, "recovered runtime loads the persisted chat grant");
      for (let i = 0; i < 100; i++) {
        const [tools, config] = await Promise.all([
          client.listTools(),
          client.callTool({ name: "get_config", arguments: {} }),
        ]);
        assert.ok(tools.tools.some((tool) => tool.name === "get_config"));
        assert.notEqual(config.isError, true);
      }
      const concurrentPublicReads = await Promise.all(
        Array.from({ length: 20 }, () => client!.callTool({ name: "get_config", arguments: {} })),
      );
      assert.ok(concurrentPublicReads.every((result) => result.isError !== true));

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
