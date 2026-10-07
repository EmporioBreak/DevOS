import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTOR_RESTART_DELAYS_MS,
  runBoundedConnectorSupervisor,
  type ConnectorSupervisorState,
} from "../src/connector-supervisor.js";

test("supervisor retries with bounded backoff then becomes terminally failed", async () => {
  const sleeps: number[] = [];
  const states: ConnectorSupervisorState[] = [];
  let launches = 0;
  await assert.rejects(
    runBoundedConnectorSupervisor({
      launch: async () => {
        launches++;
        return {
          ready: Promise.reject(new Error("startup failed")),
          exit: Promise.resolve({ code: 1, signal: null }),
          stop() {},
        };
      },
      sleep: async ms => { sleeps.push(ms); },
      onState: async state => { states.push(state); },
    }),
    /restart budget exhausted/,
  );
  assert.equal(launches, 6);
  assert.deepEqual(sleeps, CONNECTOR_RESTART_DELAYS_MS);
  assert.equal(states.at(-1)?.status, "terminal_failed");
  assert.equal(states.at(-1)?.restartAttempt, 5);
});

test("healthy stability resets the consecutive failure budget", async () => {
  let now = 0;
  let launches = 0;
  const controller = new AbortController();
  const states: ConnectorSupervisorState[] = [];
  await runBoundedConnectorSupervisor({
    signal: controller.signal,
    now: () => now,
    stableResetMs: 100,
    sleep: async () => {},
    onState: async state => { states.push(state); },
    launch: async () => {
      launches++;
      if (launches === 1) {
        return {
          ready: Promise.resolve("ok"),
          exit: Promise.resolve().then(() => { now = 150; return { code: 1, signal: null }; }),
          stop() {},
        };
      }
      controller.abort();
      return {
        ready: Promise.resolve("ok"),
        exit: new Promise(resolve => setTimeout(() => resolve({ code: 0, signal: null }), 1)),
        stop() {},
      };
    },
  });
  assert.ok(states.some(state => state.status === "healthy"));
});


test("supervisor preserves child failure component in diagnostics state", async () => {
  const states: ConnectorSupervisorState[] = [];
  await assert.rejects(
    runBoundedConnectorSupervisor({
      launch: async () => ({
        ready: Promise.reject(Object.assign(new Error("ngrok failed"), { component: "ngrok" })),
        exit: Promise.resolve({ code: 1, signal: null, component: "ngrok", message: "ngrok failed" }),
        stop() {},
      }),
      sleep: async () => {},
      onState: async state => { states.push(state); },
    }),
    /restart budget exhausted/,
  );
  assert.ok(states.some(state =>
    state.status === "recovering" &&
    state.lastFailureComponent === "ngrok"
  ));
  assert.equal(states.at(-1)?.lastFailureComponent, "ngrok");
});
