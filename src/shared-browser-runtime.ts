import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Executor, WorkerRequest } from "./executor.js";
import {
  BrowserPreSubmitFailureError,
  BrowserResumeUnavailableError,
  ChatGptBrowserExecutor,
  isBrowserPreSubmitFailureError,
  isBrowserResumeUnavailableError,
} from "./chatgpt-browser-executor.js";
import type { ChatGptBrowserConfig } from "./browser-config.js";
import type { WorkerOutput } from "./workflow.js";
import { captureProcessIdentity, processExists, sameProcessIdentity, type ProcessIdentity } from "./process-identity.js";

type WireMessage =
  | { type: "run"; request: Omit<WorkerRequest, "onSession"> }
  | { type: "bind"; projectUrl: string; token: string }
  | { type: "bind_result"; url: string }
  | { type: "close" }
  | { type: "session"; sessionId: string }
  | { type: "result"; result: WorkerOutput }
  | { type: "error"; message: string; kind?: "browser_pre_submit" | "browser_resume_unavailable" | "browser_post_submit" | "generic" }
  | { type: "closed" };

interface PendingTurn {
  promise: Promise<WorkerOutput>;
  sessionId?: string;
  clients: Set<Socket>;
}

export function browserRuntimePaths(root: string, repo: string, issue: number) {
  const key = createHash("sha256").update(`${root}\0${repo}#${issue}`).digest("hex").slice(0, 20);
  const dir = join(root, ".devos", "browser-runtime");
  return { dir, socket: join(tmpdir(), `devos-browser-${key}.sock`), metadata: join(dir, `${key}.json`), lock: join(dir, `${key}.lock`) };
}

/** Executor proxy; the detached, task-scoped process owns the actual Camoufox context. */
export class SharedBrowserExecutor implements Executor {
  readonly kind = "chatgpt_browser" as const;
  constructor(private readonly socketPath: string) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    const { onSession, ...serializable } = request;
    const socket = await connect(this.socketPath);
    const lines = readLines(socket);
    socket.write(`${JSON.stringify({ type: "run", request: serializable })}\n`);
    try {
      for await (const message of lines) {
        if (message.type === "session") await onSession?.(message.sessionId);
        else if (message.type === "result") return message.result;
        else if (message.type === "error") {
          if (message.kind === "browser_pre_submit") throw new BrowserPreSubmitFailureError(message.message);
          if (message.kind === "browser_resume_unavailable") {
            throw new BrowserResumeUnavailableError(serializable.sessionId ?? "", message.message);
          }
          throw new Error(message.message);
        }
      }
      throw new Error("Shared browser runtime disconnected during worker turn");
    } finally { socket.destroy(); }
  }
}

export async function ensureSharedBrowserRuntime(
  root: string,
  task: { repo: string; issue: number },
  config: ChatGptBrowserConfig,
): Promise<SharedBrowserExecutor> {
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  await mkdir(paths.dir, { recursive: true });
  await mkdir(dirname(paths.socket), { recursive: true, mode: 0o700 });
  if (await connectOwnedRuntime(paths.socket, paths.metadata, 500)) {
    return new SharedBrowserExecutor(paths.socket);
  }

  let lock;
  try { lock = await open(paths.lock, "wx", 0o600); }
  catch {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await delay(100);
      if (await connectOwnedRuntime(paths.socket, paths.metadata, 500)) {
        return new SharedBrowserExecutor(paths.socket);
      }
    }
    throw new Error(`Could not start shared browser runtime for issue #${task.issue}`);
  }
  try {
    const existing = await readMetadata(paths.metadata);
    if (existing) await signalOwnedRuntime(existing.pid, existing.identity);
    const entry = process.argv[1];
    if (!entry) throw new Error("Cannot locate the DevOS entrypoint for the shared browser runtime");
    const child = spawn(process.execPath, [...process.execArgv, entry, "--devos-browser-runtime", root, task.repo, String(task.issue), paths.socket, config.projectUrl, config.profileDir, config.headless ? "1" : "0"], {
      cwd: root, detached: true, stdio: "ignore", env: process.env,
    });
    child.unref();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { const socket = await connect(paths.socket, 500); socket.destroy(); return new SharedBrowserExecutor(paths.socket); } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`Shared browser runtime did not become ready for issue #${task.issue}`);
  } finally { await lock.close(); await rm(paths.lock, { force: true }); }
}

export async function resolveBindingWithActiveBrowserRuntime(
  root: string,
  projectUrl: string,
  token: string,
): Promise<string | null> {
  const dir = join(root, ".devos", "browser-runtime");
  let names: string[];
  try {
    names = (await readdir(dir)).filter(name => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const active: Array<{ socket: string; pid: number; identity: ProcessIdentity }> = [];
  for (const name of names) {
    const metadata = await readMetadata(join(dir, name));
    if (!metadata || !(await processExists(metadata.pid))) continue;
    const actual = await captureProcessIdentity(metadata.pid);
    if (!actual || !sameProcessIdentity(metadata.identity, actual) || !actual.commandLine?.includes("--devos-browser-runtime")) continue;
    active.push(metadata);
  }
  if (active.length === 0) return null;
  if (active.length > 1) throw new Error("bind_multiple_browser_runtimes");
  const socket = await connect(active[0]!.socket, 1_000);
  try {
    const lines = readLines(socket);
    socket.write(`${JSON.stringify({ type: "bind", projectUrl, token })}\n`);
    for await (const message of lines) {
      if (message.type === "bind_result") return message.url;
      if (message.type === "error") throw new Error(message.message);
    }
    throw new Error("bind_browser_runtime_disconnected");
  } finally {
    socket.destroy();
  }
}

export async function closeSharedBrowserRuntime(root: string, task: { repo: string; issue: number }): Promise<void> {
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  let graceful = false;
  let connected = false;
  let gracefulError: unknown;
  try {
    const socket = await connect(paths.socket, 1_000);
    connected = true;
    try {
      socket.write('{"type":"close"}\n');
      graceful = await waitForRuntimeClose(socket, 7_000);
    } catch (error) {
      gracefulError = error;
    } finally {
      socket.destroy();
    }
  } catch (error) {
    gracefulError = error;
  }

  if (!graceful) {
    const existing = await readMetadata(paths.metadata);
    if (existing) {
      await signalOwnedRuntime(existing.pid, existing.identity);
      try {
        const socket = await connect(paths.socket, 250);
        socket.destroy();
        throw new Error("Shared browser cleanup unconfirmed: runtime socket still accepts connections");
      } catch (error) {
        if (error instanceof Error && error.message.includes("cleanup unconfirmed")) throw error;
      }
    } else if (connected) {
      throw gracefulError instanceof Error
        ? gracefulError
        : new Error("Shared browser cleanup unconfirmed: connected runtime has no valid ownership metadata");
    }
  }
  await rm(paths.socket, { force: true });
  await rm(paths.metadata, { force: true });
}

export async function runBrowserRuntime(args: string[]): Promise<void> {
  const [root, repo, issueText, socketPath, projectUrl, profileDir, headless] = args;
  const issue = Number(issueText);
  if (!root || !repo || !Number.isSafeInteger(issue) || !socketPath || !projectUrl || !profileDir || !["0", "1"].includes(headless ?? "")) throw new Error("Invalid internal browser runtime arguments");
  const paths = browserRuntimePaths(root, repo, issue);
  const executor = new ChatGptBrowserExecutor({ projectUrl, profileDir, headless: headless === "1" });
  await startSharedBrowserServer(socketPath, paths.metadata, executor);
}

export async function startSharedBrowserServer(socketPath: string, metadataPath: string, executor: ChatGptBrowserExecutor): Promise<void> {
  const server: Server = createServer();
  let closing = false;
  const turns = new Map<string, PendingTurn>();
  const identity = await captureProcessIdentity(process.pid);
  if (!identity) throw new Error("DevOS could not prove shared browser runtime process ownership");
  const metadata = { pid: process.pid, identity, socket: socketPath };
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  server.on("connection", socket => { void handleSocket(socket, executor, turns, async () => {
    if (closing) return;
    closing = true;
    try {
      await executor.close();
      server.close();
      await rm(socketPath, { force: true });
      await rm(metadataPath, { force: true });
    } catch (error) {
      closing = false;
      throw error;
    }
  }); });
  const stop = () => { if (!closing) { closing = true; void executor.close().finally(async () => { server.close(); await rm(socketPath, { force: true }); await rm(metadataPath, { force: true }); }); } };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}

async function handleSocket(socket: Socket, executor: ChatGptBrowserExecutor, turns: Map<string, PendingTurn>, close: () => Promise<void>): Promise<void> {
  const lines = readLines(socket);
  for await (const message of lines) {
    if (message.type === "close") {
      try { await close(); socket.write('{"type":"closed"}\n'); }
      catch (error) { socket.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`); }
      return;
    }
    if (message.type === "bind") {
      try {
        const url = await executor.resolveBindingToken(message.projectUrl, message.token);
        socket.write(`${JSON.stringify({ type: "bind_result", url })}\n`);
      } catch (error) {
        socket.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      return;
    }
    if (message.type !== "run") { socket.write(`${JSON.stringify({ type: "error", message: "Invalid shared browser request" })}\n`); return; }
    try {
      const key = message.request.browserTurnId
        ?? createHash("sha256").update(JSON.stringify([message.request.workerId, message.request.sessionId, message.request.prompt])).digest("hex");
      let turn = turns.get(key);
      if (!turn) {
        const clients = new Set<Socket>([socket]);
        const created: PendingTurn = { clients, promise: Promise.resolve({ text: "" }) };
        created.promise = executor.run({ ...message.request, onSession: sessionId => {
          created.sessionId = sessionId;
          for (const client of created.clients) client.write(`${JSON.stringify({ type: "session", sessionId })}\n`);
        } }).catch(error => {
          const kind = runtimeErrorKind(error);
          if (kind !== "browser_post_submit") turns.delete(key);
          throw error;
        });
        turn = created;
        turns.set(key, turn);
      } else {
        turn.clients.add(socket);
        if (turn.sessionId) socket.write(`${JSON.stringify({ type: "session", sessionId: turn.sessionId })}\n`);
      }
      const result = await turn.promise;
      turn.clients.clear();
      socket.write(`${JSON.stringify({ type: "result", result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        kind: runtimeErrorKind(error),
      })}\n`);
    }
  }
}

async function connect(path: string, timeout = 3_000): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Shared browser connection timed out")); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
  });
}

async function* readLines(socket: Socket): AsyncGenerator<WireMessage> {
  let buffer = "";
  for await (const chunk of socket) {
    buffer += chunk.toString("utf8");
    while (true) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line) yield JSON.parse(line) as WireMessage;
    }
  }
}

async function connectOwnedRuntime(socketPath: string, metadataPath: string, timeout: number): Promise<boolean> {
  const existing = await readMetadata(metadataPath);
  if (!existing || existing.socket !== socketPath || !(await processExists(existing.pid))) return false;
  const actual = await captureProcessIdentity(existing.pid);
  if (
    !actual ||
    !sameProcessIdentity(existing.identity, actual) ||
    !actual.commandLine?.includes("--devos-browser-runtime")
  ) return false;
  try {
    const socket = await connect(socketPath, timeout);
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

async function waitForRuntimeClose(socket: Socket, timeout: number): Promise<boolean> {
  const lines = readLines(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for await (const message of lines) {
          if (message.type === "closed") return true;
          if (message.type === "error") throw new Error(message.message);
        }
        return false;
      })(),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readMetadata(path: string): Promise<{ pid: number; identity: ProcessIdentity; socket: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const identity = value.identity as ProcessIdentity;
    return Number.isSafeInteger(value.pid) &&
      identity?.pid === value.pid &&
      typeof identity.startTime === "string" &&
      typeof identity.executable === "string" &&
      typeof identity.commandLine === "string" &&
      typeof value.socket === "string"
      ? value
      : undefined;
  }
  catch { return undefined; }
}
async function signalOwnedRuntime(pid: number, identity: ProcessIdentity): Promise<void> {
  if (pid <= 1 || pid === process.pid) throw new Error("Invalid shared browser runtime owner metadata");
  if (!(await processExists(pid))) return;
  const actual = await captureProcessIdentity(pid);
  if (!actual) throw new Error("Cannot validate the existing shared browser runtime owner");
  if (!sameProcessIdentity(identity, actual)) return;
  if (!actual.commandLine?.includes("--devos-browser-runtime")) throw new Error("Refusing to stop a process not identified as the shared browser runtime");
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (!(await processExists(pid))) return;
    const current = await captureProcessIdentity(pid);
    if (current && !sameProcessIdentity(identity, current)) return;
    await delay(100);
  }
  throw new Error("The previous shared browser runtime did not stop within the cleanup deadline");
}
function runtimeErrorKind(error: unknown): "browser_pre_submit" | "browser_resume_unavailable" | "browser_post_submit" | "generic" {
  if (isBrowserPreSubmitFailureError(error)) return "browser_pre_submit";
  if (isBrowserResumeUnavailableError(error)) return "browser_resume_unavailable";
  const message = error instanceof Error ? error.message : String(error);
  return /phase=post-submit/i.test(message) ? "browser_post_submit" : "generic";
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
