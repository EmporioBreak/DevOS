import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { browserRuntimePaths, closeSharedBrowserRuntime, SharedBrowserExecutor, startSharedBrowserServer } from "../src/shared-browser-runtime.js";
import { BrowserPreSubmitFailureError, type ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { BrowserCommandBroker, type BrowserCommand } from "../src/browser-command-broker.js";

test("shared runtime IPC commits one durable browser command claim and provider receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-broker-ipc-"));
  const task = { repo: "owner/repo", issue: 73 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  const command: BrowserCommand = {
    repo: task.repo, issue: task.issue, workerId: "developer", turn: 1,
    commandId: "cmd-73-1", runtimeIncarnation: "runtime-a", profileOwner: "profile-a",
    windowLease: "window-73", tabLease: "tab-73", documentId: "doc-a",
    navigationEpoch: 2, conversationId: "conversation-a", payloadSha256: "a".repeat(64),
  };
  const executor = { async run() { return { text: "unused" }; }, async close() {} } as unknown as ChatGptBrowserExecutor;
  try {
    const broker = new BrowserCommandBroker(root);
    await startSharedBrowserServer(paths.socket, paths.metadata, executor, undefined, broker);
    const client = new SharedBrowserExecutor(paths.socket) as any;
    assert.equal(typeof client.prepareBrowserCommand, "function", "browser broker IPC is missing");
    await client.prepareBrowserCommand(command);
    assert.equal(await client.claimBrowserCommand(command.commandId, command), true);
    const receipt = {
      repo: task.repo, issue: task.issue, workerId: "developer", turn: 1,
      commandId: command.commandId, payloadSha256: command.payloadSha256,
      conversationId: "conversation-a", messageId: "provider-message-73",
    };
    await client.recordBrowserProviderReceipt(command.commandId, receipt);
    const restarted = new SharedBrowserExecutor(paths.socket) as any;
    await restarted.acknowledgeBrowserCommand(command.commandId, receipt);
    assert.equal((await broker.get(command.commandId))?.status, "acknowledged");
    assert.equal(await client.claimBrowserCommand(command.commandId, command), false);
  } finally {
    await closeSharedBrowserRuntime(root, task);
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("shared runtime carries session updates and keeps its executor across client disconnects", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-"));
  const task = { repo: "owner/repo", issue: 74 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  let calls = 0;
  let closes = 0;
  const executor = {
    async run(request: { onSession?: (sessionId: string) => void | Promise<void> }) {
      calls++;
      await request.onSession?.(`https://chatgpt.com/g/project/c/session-${calls}`);
      return { text: `turn-${calls}`, sessionId: `https://chatgpt.com/g/project/c/session-${calls}` };
    },
    async close() { closes++; },
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const client = new SharedBrowserExecutor(paths.socket);
    const sessions: string[] = [];
    const first = await client.run({ projectRoot: root, prompt: "one", onSession: id => { sessions.push(id); } });
    const second = await client.run({ projectRoot: root, prompt: "two" });
    assert.equal(first.text, "turn-1");
    assert.equal(second.text, "turn-2");
    assert.deepEqual(sessions, ["https://chatgpt.com/g/project/c/session-1"]);
    assert.equal(calls, 2);
    assert.equal(closes, 0);
    await closeSharedBrowserRuntime(root, task);
    assert.equal(closes, 1);
  } finally {
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a client reconnect during a worker turn attaches to the same in-flight submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-resume-"));
  const paths = browserRuntimePaths(root, "owner/repo", 75);
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const executor = {
    async run(request: { onSession?: (sessionId: string) => void | Promise<void> }) {
      calls++;
      await request.onSession?.("https://chatgpt.com/g/project/c/in-flight");
      await pending;
      return { text: "finished once", sessionId: "https://chatgpt.com/g/project/c/in-flight" };
    },
    async close() {},
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const abandoned = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
      const socket = createConnection(paths.socket);
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    abandoned.write(`${JSON.stringify({ type: "run", request: { projectRoot: root, prompt: "same turn", workerId: "developer" } })}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
    abandoned.destroy();

    const resumed = new SharedBrowserExecutor(paths.socket).run({ projectRoot: root, prompt: "same turn", workerId: "developer" });
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    assert.equal((await resumed).text, "finished once");
    assert.equal(calls, 1, "reconnection must not send the worker prompt twice");
  } finally {
    release();
    await closeSharedBrowserRuntime(root, { repo: "owner/repo", issue: 75 });
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct browser turn ids never reuse a completed result from an earlier review loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-turns-"));
  const task = { repo: "owner/repo", issue: 76 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  let calls = 0;
  const executor = {
    async run() {
      calls++;
      return { text: "turn-" + calls };
    },
    async close() {},
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const client = new SharedBrowserExecutor(paths.socket);
    const first = await client.run({
      projectRoot: root,
      prompt: "same worker prompt",
      workerId: "developer",
      browserTurnId: "0:developer",
    });
    const second = await client.run({
      projectRoot: root,
      prompt: "same worker prompt",
      workerId: "developer",
      browserTurnId: "2:developer",
    });
    assert.equal(first.text, "turn-1");
    assert.equal(second.text, "turn-2");
    assert.equal(calls, 2);
  } finally {
    await closeSharedBrowserRuntime(root, task);
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-submit error type survives IPC and same turn can retry without being cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-errors-"));
  const task = { repo: "owner/repo", issue: 77 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  let calls = 0;
  const executor = {
    async run() {
      calls++;
      if (calls === 1) throw new BrowserPreSubmitFailureError("safe before submit");
      return { text: "retried" };
    },
    async close() {},
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const client = new SharedBrowserExecutor(paths.socket);
    const request = {
      projectRoot: root,
      prompt: "same turn",
      workerId: "developer",
      browserTurnId: "0:developer",
    };
    await assert.rejects(client.run(request), BrowserPreSubmitFailureError);
    assert.equal((await client.run(request)).text, "retried");
    assert.equal(calls, 2);
  } finally {
    await closeSharedBrowserRuntime(root, task);
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("post-submit ambiguity is cached for the same turn and never replays the prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-post-submit-"));
  const task = { repo: "owner/repo", issue: 78 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  let calls = 0;
  const executor = {
    async run() {
      calls++;
      throw new Error("Browser recovery attempt=1 phase=post-submit: prompt not replayed");
    },
    async close() {},
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const client = new SharedBrowserExecutor(paths.socket);
    const request = {
      projectRoot: root,
      prompt: "same turn",
      workerId: "developer",
      browserTurnId: "0:developer",
    };
    await assert.rejects(client.run(request), /phase=post-submit/);
    await assert.rejects(client.run(request), /phase=post-submit/);
    assert.equal(calls, 1);
  } finally {
    await closeSharedBrowserRuntime(root, task);
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("failed graceful runtime close preserves ownership metadata so cleanup can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-close-retry-"));
  const task = { repo: "owner/repo", issue: 78 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  let closes = 0;
  let failClose = true;
  const executor = {
    async run() { return { text: "unused" }; },
    async close() {
      closes++;
      if (failClose) throw new Error("simulated executor close failure");
    },
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
      const client = createConnection(paths.socket);
      client.once("connect", () => resolve(client));
      client.once("error", reject);
    });
    const response = new Promise<string>((resolve, reject) => {
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        const end = buffer.indexOf("\n");
        if (end >= 0) resolve(buffer.slice(0, end));
      });
      socket.once("error", reject);
    });
    socket.write('{"type":"close"}\n');
    const message = JSON.parse(await response) as { type: string; message?: string };
    socket.destroy();

    assert.equal(message.type, "error");
    assert.match(message.message ?? "", /simulated executor close failure/);
    assert.match(await readFile(paths.metadata, "utf8"), /"pid"/);

    failClose = false;
    await closeSharedBrowserRuntime(root, task);
    assert.equal(closes, 2);
  } finally {
    await rm(paths.socket, { force: true });
    await rm(paths.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("unowned socket cannot be closed as if it were a DevOS browser runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-unowned-socket-"));
  const task = { repo: "other/repo", issue: 88 };
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  const server = createServer(socket => socket.end("unrelated\n"));
  try {
    await new Promise<void>(resolve => server.listen(paths.socket, resolve));
    await assert.rejects(closeSharedBrowserRuntime(root, task),
      /unowned runtime socket/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(paths.socket, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
