import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { captureProcessIdentity } from "../src/process-identity.js";
import { assertSavedConversationTaskOwner, browserRuntimePaths, legacyBrowserRuntimePaths, findOwnedLegacyBrowserRuntime, browserTaskKey, canonicalConversationIdentity, closeSharedBrowserRuntime, SharedBrowserExecutor, startSharedBrowserServer } from "../src/shared-browser-runtime.js";
import { BrowserPreSubmitFailureError, type ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";

test("conversation ownership ignores mutable Project slugs but distinguishes exact saved chats", () => {
  assert.equal(
    canonicalConversationIdentity("https://chatgpt.com/g/old-project-slug/c/conv-1"),
    canonicalConversationIdentity("https://chatgpt.com/g/new-project-slug/c/conv-1"),
  );
  assert.notEqual(
    canonicalConversationIdentity("https://chatgpt.com/g/project/c/conv-1"),
    canonicalConversationIdentity("https://chatgpt.com/g/project/c/conv-2"),
  );
  assert.throws(() => canonicalConversationIdentity("https://chatgpt.com/g/project"), /conversation identity/);
});

test("saved conversation state from another Issue blocks cross-task reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-conversation-owner-"));
  const stateDir = join(root, ".devos", "state");
  const taskA = { repo: "owner/repo", issue: 41 };
  const taskB = { repo: "owner/repo", issue: 42 };
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "owner%2Frepo-issue-41.json"), JSON.stringify({
      task: taskA,
      sessions: { developer: "https://chatgpt.com/g/old-slug/c/shared-conversation" },
    }));
    await assert.rejects(
      assertSavedConversationTaskOwner(root, taskB, "https://chatgpt.com/g/new-slug/c/shared-conversation"),
      /already recorded for owner\/repo#41/,
    );
    await assert.doesNotReject(assertSavedConversationTaskOwner(root, taskA, "https://chatgpt.com/g/new-slug/c/shared-conversation"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one project runtime namespaces two Issues and closing one leaves the other live", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-project-"));
  const taskA = { repo: "owner/repo", issue: 74 };
  const taskB = { repo: "owner/repo", issue: 75 };
  const pathsA = browserRuntimePaths(root, taskA.repo, taskA.issue);
  const pathsB = browserRuntimePaths(root, taskB.repo, taskB.issue);
  const calls: string[] = [];
  const closed: string[] = [];
  const executor = {
    async run(request: { task?: typeof taskA; browserTurnId?: string }) {
      calls.push(`${browserTaskKey(request.task!)}:${request.browserTurnId}`);
      return { text: request.task!.issue.toString() };
    },
    async closeTask(task: typeof taskA) { closed.push(browserTaskKey(task)); return task.issue === taskA.issue; },
    async close() {},
  } as unknown as ChatGptBrowserExecutor;
  try {
    assert.equal(pathsA.socket, pathsB.socket, "Issues in one checkout must use the same runtime socket");
    assert.notEqual(browserTaskKey(taskA), browserTaskKey(taskB), "task identity remains distinct inside the runtime");
    await startSharedBrowserServer(pathsA.socket, pathsA.metadata, executor);
    const clientA = new SharedBrowserExecutor(pathsA.socket, taskA);
    const clientB = new SharedBrowserExecutor(pathsB.socket, taskB);
    assert.equal((await clientA.run({ projectRoot: root, prompt: "same", workerId: "developer", browserTurnId: "0:developer" })).text, "74");
    assert.equal((await clientB.run({ projectRoot: root, prompt: "same", workerId: "developer", browserTurnId: "0:developer" })).text, "75");
    assert.equal(calls.length, 2, "same worker/turn names in different Issues must never deduplicate");
    await closeSharedBrowserRuntime(root, taskA);
    assert.deepEqual(closed, [browserTaskKey(taskA)]);
    assert.equal((await clientB.run({ projectRoot: root, prompt: "next", workerId: "developer", browserTurnId: "1:developer" })).text, "75");
  } finally {
    await closeSharedBrowserRuntime(root, taskB).catch(() => undefined);
    await rm(pathsA.socket, { force: true });
    await rm(pathsA.metadata, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("failed task-local close never terminates another retained Issue runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-close-isolation-"));
  const taskA = { repo: "owner/repo", issue: 74 };
  const taskB = { repo: "owner/repo", issue: 75 };
  const paths = browserRuntimePaths(root, taskA.repo, taskA.issue);
  let alive = true;
  const executor = {
    async run(request: { task: typeof taskA }) { return { text: String(request.task.issue) }; },
    async closeTask(task: typeof taskA) {
      if (task.issue === taskA.issue) throw new Error("simulated task window close failure");
      return false;
    },
    async close() { alive = false; },
  } as unknown as ChatGptBrowserExecutor;
  try {
    await startSharedBrowserServer(paths.socket, paths.metadata, executor);
    await assert.rejects(closeSharedBrowserRuntime(root, taskA), /simulated task window close failure|cleanup unconfirmed/);
    assert.equal(alive, true, "failed scoped close must not close shared browser");
    const other = new SharedBrowserExecutor(paths.socket, taskB);
    assert.equal((await other.run({ projectRoot: root, prompt: "retained", workerId: "developer" })).text, "75");
    assert.match(await readFile(paths.metadata, "utf8"), /"pid"/);
  } finally {
    await closeSharedBrowserRuntime(root, taskB).catch(() => undefined);
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


test("pre-existing exact Issue worker may reconnect to its own live legacy IPC without spawning a second profile",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-legacy-browser-"));
  const task={repo:"owner/repo",issue:311};
  const config={projectUrl:"https://chatgpt.com/g/project",profileDir:join(root,"profile"),headless:false};
  const legacy=legacyBrowserRuntimePaths(root,task);
  const project=browserRuntimePaths(root,task.repo,task.issue);
  const stateDir=join(root,".devos","state");
  await mkdir(legacy.dir,{recursive:true});
  await mkdir(stateDir,{recursive:true});
  const server=createServer(socket=>socket.end());
  let child:ReturnType<typeof spawn>|undefined;
  try{
    assert.notEqual(legacy.socket,project.socket);
    assert.notEqual(legacy.metadata,project.metadata);
    assert.equal(await findOwnedLegacyBrowserRuntime(root,task,config),null);
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(legacy.socket,resolve)});
    child=spawn(process.execPath,["-e","setInterval(()=>{},1000)","--", "--devos-browser-runtime",root,task.repo,String(task.issue),legacy.socket,config.projectUrl,config.profileDir,"0"],{stdio:"ignore"});
    let identity=await captureProcessIdentity(child.pid!);
    for(let i=0;i<40&&!identity;i++){
      await new Promise(resolve=>setTimeout(resolve,25));
      identity=await captureProcessIdentity(child.pid!);
    }
    assert.ok(identity);
    await writeFile(legacy.metadata,JSON.stringify({pid:child.pid,identity,socket:legacy.socket}),{mode:0o600});
    assert.equal(await findOwnedLegacyBrowserRuntime(root,task,config),null,"must never attach without existing saved worker conversation");
    await writeFile(join(stateDir,"owner%2Frepo-issue-311.json"),JSON.stringify({task,currentWorkerId:"developer",completedRuns:2,sessions:{developer:"https://chatgpt.com/c/existing"}}));
    assert.equal(await findOwnedLegacyBrowserRuntime(root,task,config),legacy.socket);
    assert.equal(await findOwnedLegacyBrowserRuntime(root,{...task,issue:312},config),null);
    assert.equal(await findOwnedLegacyBrowserRuntime(root,task,{...config,profileDir:join(root,"other")}),null);
    assert.equal(await findOwnedLegacyBrowserRuntime(root,task,{...config,projectUrl:"https://chatgpt.com/g/other"}),null);
  }finally{
    child?.kill("SIGTERM");
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
