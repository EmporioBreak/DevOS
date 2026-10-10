import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
import { profileProcesses, terminateOwnedBrowser, type OwnedBrowserProcess } from "./owned-browser-process.js";
import type { TaskRef, WorkerOutput } from "./workflow.js";
import { captureProcessIdentity, processExists, sameProcessIdentity, type ProcessIdentity } from "./process-identity.js";

type WireMessage =
  | { type: "run"; request: Omit<WorkerRequest, "onSession"> }
  | { type: "close" }
  | { type: "close_task"; task: TaskRef }
  | { type: "session"; sessionId: string }
  | { type: "result"; result: WorkerOutput }
  | { type: "error"; message: string; kind?: "browser_pre_submit" | "browser_resume_unavailable" | "browser_post_submit" | "generic" }
  | { type: "closed" }
  | { type: "task_closed" };

interface PendingTurn {
  promise: Promise<WorkerOutput>;
  sessionId?: string;
  clients: Set<Socket>;
}

export function browserRuntimePaths(root: string, repo: string, issue: number) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const dir = join(root, ".devos", "browser-runtime");
  return { dir, socket: join(tmpdir(), `devos-browser-${key}.sock`), metadata: join(dir, `${key}.json`), lock: join(dir, `${key}.lock`) };
}

export function browserTaskKey(task: TaskRef): string {
  return `${task.repo}#${task.issue}`;
}

/** Executor proxy; the detached, task-scoped process owns the actual Camoufox context. */
export class SharedBrowserExecutor implements Executor {
  readonly kind = "chatgpt_browser" as const;
  constructor(private readonly socketPath: string, private readonly task?: TaskRef) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    const { onSession, ...input } = request;
    const task = this.task ?? input.task ?? input.reportTurn?.task ?? { repo: "__legacy_test__", issue: 0 };
    if ((input.task && browserTaskKey(input.task) !== browserTaskKey(task)) ||
        (input.reportTurn && browserTaskKey(input.reportTurn.task) !== browserTaskKey(task)))
      throw new Error("Shared browser request task does not match its bound Issue or worker report");
    const serializable = { ...input, task };
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
  if (await connectOwnedRuntime(paths.socket, paths.metadata, 500, config)) {
    return new SharedBrowserExecutor(paths.socket, task);
  }

  let lock;
  try { lock = await open(paths.lock, "wx", 0o600); }
  catch {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await delay(100);
      if (await connectOwnedRuntime(paths.socket, paths.metadata, 500, config)) {
        return new SharedBrowserExecutor(paths.socket);
      }
    }
    throw new Error(`Could not start shared browser runtime for issue #${task.issue}`);
  }
  try {
    const existing = await readMetadata(paths.metadata);
    if (!existing && (await pathExists(paths.metadata) || await pathExists(paths.socket)))
      throw new Error("Project browser runtime metadata or socket is unowned; refusing to replace ambiguous ownership");
    if (existing) {
      const actual = await captureProcessIdentity(existing.pid);
      if (actual && sameProcessIdentity(existing.identity, actual)) {
        throw new Error("Project browser runtime owner is live but its socket is unavailable; refusing to replace a possibly active task window");
      }
    }
    const profileOwners = await profileProcesses(config.profileDir);
    if (profileOwners.length) {
      throw new Error(`Refusing to launch a second Camoufox context for the shared profile; live process owner(s): ${profileOwners.map(owner => owner.pid).join(", ")}`);
    }
    if (existing) {
      await rm(paths.socket, { force: true });
      await rm(paths.metadata, { force: true });
    }
    const entry = process.argv[1];
    if (!entry) throw new Error("Cannot locate the DevOS entrypoint for the shared browser runtime");
    const child = spawn(process.execPath, [...process.execArgv, entry, "--devos-browser-runtime", root, paths.socket, config.projectUrl, config.profileDir, config.headless ? "1" : "0"], {
      cwd: root, detached: true, stdio: "ignore", env: process.env,
    });
    child.unref();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try { const socket = await connect(paths.socket, 500); socket.destroy(); return new SharedBrowserExecutor(paths.socket, task); } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`Shared browser runtime did not become ready for issue #${task.issue}`);
  } finally { await lock.close(); await rm(paths.lock, { force: true }); }
}

export async function closeSharedBrowserRuntime(root: string, task: { repo: string; issue: number }): Promise<void> {
  const paths = browserRuntimePaths(root, task.repo, task.issue);
  // The runtime may remove its metadata before the close acknowledgement is
  // observed. Capture ownership first: an acknowledgement is NOT proof that
  // the detached Node process has exited.
  const owner = await readMetadata(paths.metadata);
  if (!owner) {
    // Nothing left to close is idempotently successful, but a live IPC socket
    // without verifiable owner metadata must NEVER receive a close command.
    let metadataPresent = false;
    try { await readFile(paths.metadata); metadataPresent = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (metadataPresent)
      throw new Error("Shared browser cleanup unconfirmed: invalid runtime ownership metadata");
    try {
      const unowned = await connect(paths.socket, 250);
      unowned.destroy();
      throw new Error("Shared browser cleanup unconfirmed: unowned runtime socket");
    } catch (error) {
      if (error instanceof Error && error.message.includes("cleanup unconfirmed")) throw error;
    }
    await rm(paths.socket, { force: true });
    return;
  }
  if (owner.pid !== process.pid) {
    const identity = await captureProcessIdentity(owner.pid);
    if (identity && !sameProcessIdentity(owner.identity, identity))
      throw new Error("Shared browser cleanup unconfirmed: runtime ownership changed");
  }
  let graceful = false;
  let connected = false;
  let gracefulError: unknown;
  try {
    const socket = await connect(paths.socket, 1_000);
    connected = true;
    try {
      socket.write(`${JSON.stringify({ type: "close_task", task })}\n`);
      const result = await waitForRuntimeClose(socket, 7_000);
      if (result === "task_closed") return;
      graceful = result === "closed";
    } catch (error) {
      gracefulError = error;
    } finally {
      socket.destroy();
    }
  } catch (error) {
    gracefulError = error;
  }

  if (!graceful) {
    // An ambiguous task-local close must never kill the shared process: other
    // Issues may still own windows, sessions and in-flight turns within it.
    throw gracefulError instanceof Error
      ? gracefulError
      : new Error("Shared browser task cleanup unconfirmed: other task leases may exist");
  }
  // Check the *process*, not merely the IPC socket. The detached browser
  // runtime may retain an event loop with zero visible tabs.
  if (graceful && owner && owner.pid !== process.pid) {
    if (!(await waitOwnedRuntimeExit(owner.pid, owner.identity, 1_500))) {
      await signalOwnedRuntime(owner.pid, owner.identity);
    }
  }
  if (owner && owner.pid !== process.pid &&
      !(await waitOwnedRuntimeExit(owner.pid, owner.identity, 500))) {
    throw new Error("Shared browser cleanup unconfirmed: owned runtime process still alive");
  }
  // If the runtime needed SIGKILL, its Camoufox child could outlive it.
  // Capture exact process ownership BEFORE asking the runtime to stop; never
  // scan-and-kill unrelated browser profiles or arbitrary OS processes.
  if (owner?.browserRoot && owner.profileDir) {
    const alive = (await profileProcesses(owner.profileDir)).some(
      item => item.pid === owner.browserRoot!.pid && item.identity === owner.browserRoot!.identity,
    );
    if (alive && !(await terminateOwnedBrowser(owner.browserRoot, owner.profileDir)))
      throw new Error("Shared browser cleanup unconfirmed: owned Camoufox root remains alive");
  }
  await rm(paths.socket, { force: true });
  await rm(paths.metadata, { force: true });
}

export async function runBrowserRuntime(args: string[]): Promise<void> {
  const [root, socketPath, projectUrl, profileDir, headless] = args;
  if (!root || !socketPath || !projectUrl || !profileDir || !["0", "1"].includes(headless ?? "")) throw new Error("Invalid internal browser runtime arguments");
  const paths = browserRuntimePaths(root, "", 0);
  if (socketPath !== paths.socket) throw new Error("Internal browser runtime socket does not match its Production checkout owner path");
  let metadataWrites = Promise.resolve();
  const updateMetadata = async (update: (current: BrowserRuntimeMetadata) => BrowserRuntimeMetadata) => {
    const operation = metadataWrites.then(async () => {
      const current = await readMetadata(paths.metadata);
      if (!current || current.pid !== process.pid)
        throw new Error("Cannot persist browser ownership without exact project runtime identity");
      await writeMetadataAtomic(paths.metadata, update(current));
    });
    metadataWrites = operation.then(() => undefined, () => undefined);
    await operation;
  };
  const executor = new ChatGptBrowserExecutor(
    { projectUrl, profileDir, headless: headless === "1" },
    undefined,
    async browserRoot => {
      await updateMetadata(existing => ({ ...existing, browserRoot, profileDir }));
    },
    async (task, marker) => {
      await updateMetadata(existing => {
        const taskWindows = { ...(existing.taskWindows ?? {}) };
        if (marker) taskWindows[browserTaskKey(task)] = marker;
        else delete taskWindows[browserTaskKey(task)];
        return { ...existing, taskWindows };
      });
    },
    async (task, sessionId) => {
      await assertSavedConversationTaskOwner(root, task, sessionId);
      await updateMetadata(existing => {
        const taskSessions = { ...(existing.taskSessions ?? {}) };
        const digest = createHash("sha256").update(canonicalConversationIdentity(sessionId)).digest("hex");
        const owner = taskSessions[digest];
        if (owner && owner !== browserTaskKey(task))
          throw new Error("Saved ChatGPT conversation is already owned by a different Issue");
        taskSessions[digest] = browserTaskKey(task);
        return { ...existing, taskSessions };
      });
    },
  );
  await startSharedBrowserServer(socketPath, paths.metadata, executor, { projectUrl, profileDir, headless: headless === "1" });
}

export function canonicalConversationIdentity(sessionId: string): string {
  let url: URL;
  try { url = new URL(sessionId); }
  catch { throw new Error("Saved browser session has no canonical conversation identity"); }
  const match = /\/c\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error("Saved browser session has no canonical conversation identity");
  let id: string;
  try { id = decodeURIComponent(match[1]!); }
  catch { throw new Error("Saved browser session has an invalid conversation identity"); }
  return `${url.origin}/c/${id}`;
}

export async function assertSavedConversationTaskOwner(root: string, task: TaskRef, sessionId: string): Promise<void> {
  const identity = canonicalConversationIdentity(sessionId);
  const directory = join(root, ".devos", "state");
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.filter(name => name.endsWith(".json"))) {
    const record = JSON.parse(await readFile(join(directory, entry), "utf8")) as Record<string, unknown>;
    let owner = record.task as TaskRef | undefined;
    if (!owner || typeof owner.repo !== "string" || !Number.isSafeInteger(owner.issue)) {
      const match = /^(.*)-issue-(\d+)\.json$/.exec(entry);
      if (!match) continue;
      let repo: string;
      try { repo = decodeURIComponent(match[1]!); } catch { throw new Error("Cannot verify ownership of saved browser task state"); }
      owner = { repo, issue: Number(match[2]) };
    }
    if (!record.sessions || typeof record.sessions !== "object" || Array.isArray(record.sessions)) continue;
    for (const session of Object.values(record.sessions as Record<string, unknown>)) {
      if (typeof session !== "string") continue;
      let savedIdentity: string;
      try { savedIdentity = canonicalConversationIdentity(session); } catch { continue; }
      if (savedIdentity === identity && browserTaskKey(owner) !== browserTaskKey(task))
        throw new Error(`Saved ChatGPT conversation is already recorded for ${browserTaskKey(owner)}`);
    }
  }
}

export async function startSharedBrowserServer(
  socketPath: string,
  metadataPath: string,
  executor: ChatGptBrowserExecutor,
  config?: { projectUrl: string; profileDir: string; headless: boolean },
): Promise<void> {
  const server: Server = createServer();
  let closing = false;
  const turns = new Map<string, PendingTurn>();
  const identity = await captureProcessIdentity(process.pid);
  if (!identity) throw new Error("DevOS could not prove shared browser runtime process ownership");
  const metadata = { pid: process.pid, identity, socket: socketPath, ...config };
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  await mkdir(dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
  const stopRuntime = async () => {
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
  };
  const closeTask = async (task: TaskRef): Promise<boolean> => {
    const taskExecutor = executor as ChatGptBrowserExecutor & { closeTask?: (task: TaskRef) => Promise<boolean> };
    if (!taskExecutor.closeTask) {
      await stopRuntime();
      return false;
    }
    const hasOtherTasks = await taskExecutor.closeTask(task);
    const prefix = `${browserTaskKey(task)}\0`;
    for (const key of turns.keys()) if (key.startsWith(prefix)) turns.delete(key);
    if (!hasOtherTasks) await stopRuntime();
    return hasOtherTasks;
  };
  server.on("connection", socket => { void handleSocket(socket, executor, turns, closeTask, stopRuntime); });
  const stop = () => { if (!closing) { closing = true; void executor.close().finally(async () => { server.close(); await rm(socketPath, { force: true }); await rm(metadataPath, { force: true }); }); } };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}

async function handleSocket(socket: Socket, executor: ChatGptBrowserExecutor, turns: Map<string, PendingTurn>, closeTask: (task: TaskRef) => Promise<boolean>, closeRuntime: () => Promise<void>): Promise<void> {
  const lines = readLines(socket);
  for await (const message of lines) {
    if (message.type === "close") {
      try {
        await closeRuntime();
        socket.end('{"type":"closed"}\n');
      } catch (error) {
        socket.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      return;
    }
    if (message.type === "close_task") {
      try {
        const hasOtherTasks = await closeTask(message.task);
        socket.end(hasOtherTasks ? '{"type":"task_closed"}\n' : '{"type":"closed"}\n');
      } catch (error) {
        socket.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      return;
    }
    if (message.type !== "run" || !message.request.task ||
        (message.request.reportTurn && browserTaskKey(message.request.reportTurn.task) !== browserTaskKey(message.request.task))) {
      socket.write(`${JSON.stringify({ type: "error", message: "Shared browser request is missing consistent exact task identity" })}\n`);
      return;
    }
    try {
      const key = `${browserTaskKey(message.request.task)}\0${message.request.browserTurnId
        ?? createHash("sha256").update(JSON.stringify([message.request.workerId, message.request.sessionId, message.request.prompt])).digest("hex")}`;
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

async function connectOwnedRuntime(socketPath: string, metadataPath: string, timeout: number, config?: ChatGptBrowserConfig): Promise<boolean> {
  const existing = await readMetadata(metadataPath);
  if (!existing || existing.socket !== socketPath || !(await processExists(existing.pid))) return false;
  if (config && (existing.projectUrl !== config.projectUrl || existing.profileDir !== config.profileDir || existing.headless !== config.headless)) return false;
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

async function waitForRuntimeClose(socket: Socket, timeout: number): Promise<"closed" | "task_closed" | false> {
  const lines = readLines(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for await (const message of lines) {
          if (message.type === "closed" || message.type === "task_closed") return message.type;
          if (message.type === "error") throw new Error(message.message);
        }
        return false;
      })(),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface BrowserRuntimeMetadata {
  pid: number;
  identity: ProcessIdentity;
  socket: string;
  browserRoot?: OwnedBrowserProcess;
  profileDir?: string;
  projectUrl?: string;
  headless?: boolean;
  taskWindows?: Record<string, string>;
  taskSessions?: Record<string, string>;
}

async function writeMetadataAtomic(path: string, data: BrowserRuntimeMetadata): Promise<void> {
  const temp = path + ".tmp-" + process.pid;
  try {
    await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function readMetadata(path: string): Promise<BrowserRuntimeMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const identity = value.identity as ProcessIdentity;
    return Number.isSafeInteger(value.pid) &&
      identity?.pid === value.pid &&
      typeof identity.startTime === "string" &&
      typeof identity.executable === "string" &&
      typeof identity.commandLine === "string" &&
      typeof value.socket === "string" &&
      (value.browserRoot === undefined ||
        (Number.isSafeInteger(value.browserRoot.pid) &&
          typeof value.browserRoot.identity === "string" &&
          typeof value.profileDir === "string")) &&
      (value.taskWindows === undefined ||
        (typeof value.taskWindows === "object" && value.taskWindows !== null &&
          Object.entries(value.taskWindows).every(([task, marker]) =>
            /^.+#\d+$/.test(task) && typeof marker === "string" && marker.startsWith("devos-task-window:")))) &&
      (value.taskSessions === undefined ||
        (typeof value.taskSessions === "object" && value.taskSessions !== null &&
          Object.entries(value.taskSessions).every(([digest, task]) => /^[a-f0-9]{64}$/.test(digest) && typeof task === "string" && /^.+#\d+$/.test(task)))) &&
      (value.projectUrl === undefined || typeof value.projectUrl === "string") &&
      (value.headless === undefined || typeof value.headless === "boolean")
      ? value as BrowserRuntimeMetadata
      : undefined;
  }
  catch { return undefined; }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** A restarted process may reuse the same PID: only the original process
 * identity counts as alive. Never wait on or signal a different owner. */
async function waitOwnedRuntimeExit(
  pid: number, identity: ProcessIdentity, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processExists(pid))) return true;
    const actual = await captureProcessIdentity(pid);
    if (!actual || !sameProcessIdentity(identity, actual)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  } while (true);
}

async function signalOwnedRuntime(pid: number, identity: ProcessIdentity): Promise<void> {
  if (pid <= 1 || pid === process.pid) throw new Error("Invalid shared browser runtime owner metadata");
  if (await waitOwnedRuntimeExit(pid, identity, 0)) return;
  const actual = await captureProcessIdentity(pid);
  if (!actual || !sameProcessIdentity(identity, actual)) return;
  if (!actual.commandLine?.includes("--devos-browser-runtime"))
    throw new Error("Refusing to stop a process not identified as the shared browser runtime");

  try { process.kill(pid, "SIGTERM"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  if (await waitOwnedRuntimeExit(pid, identity, 4_000)) return;

  // Only the exact same task-scoped process (PID + start time + executable +
  // argv) may receive the hard kill. Never use process-group or broad pkill.
  const remaining = await captureProcessIdentity(pid);
  if (!remaining || !sameProcessIdentity(identity, remaining)) return;
  if (!remaining.commandLine?.includes("--devos-browser-runtime"))
    throw new Error("Refusing to force-stop an unverified runtime process");
  try { process.kill(pid, "SIGKILL"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  if (await waitOwnedRuntimeExit(pid, identity, 2_000)) return;
  throw new Error("The previous shared browser runtime did not stop within the cleanup deadline");
}

function runtimeErrorKind(error: unknown): "browser_pre_submit" | "browser_resume_unavailable" | "browser_post_submit" | "generic" {
  if (isBrowserPreSubmitFailureError(error)) return "browser_pre_submit";
  if (isBrowserResumeUnavailableError(error)) return "browser_resume_unavailable";
  const message = error instanceof Error ? error.message : String(error);
  return /phase=post-submit/i.test(message) ? "browser_post_submit" : "generic";
}

function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
