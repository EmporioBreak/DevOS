import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { loadConnectorSecrets, type ConnectorSecrets } from "./connector-env.js";
import { desktopCommand, safeEnvironment } from "./connector-process.js";
import { captureProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import { runBoundedConnectorSupervisor, type ConnectorSupervisorState } from "./connector-supervisor.js";
import { appendConnectorDiagnostic, appendDesktopCommanderDiagnostic } from "./connector-diagnostics.js";
import {
  startGateway,
  ownerAuth,
  publicIdentity,
} from "./connector-gateway.js";
export { startGateway } from "./connector-gateway.js";
export const NGROK_VERSION = "3.39.11";
export const DESKTOP_VERSION = "0.2.52";
export type ConnectorTunnel = "ngrok" | "cloudflare";
export type ConnectorAction =
  | "setup"
  | "doctor"
  | "run"
  | "start"
  | "stop"
  | "status";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const softwareRoot = resolve(
  moduleDir,
  existsSync(join(moduleDir, "../package.json")) ? ".." : "../..",
);
// Versioned official archives with published Homebrew cask SHA256s.
// No latest URL, global install or updater; downloaded bytes are verified.
const releases: Record<string, { url: string; sha256: string }> = {
  "darwin-arm64": {
    url: "https://bin.ngrok.com/a/dy27whJwwmb/ngrok-v3-3.39.11-darwin-arm64.zip",
    sha256: "9324a6552d74e25d5bdfdbedc4b32422c96f044fda37877498ad8ef10bddf7f7",
  },
  "darwin-x64": {
    url: "https://bin.ngrok.com/a/8QQF2ciKqxM/ngrok-v3-3.39.11-darwin-amd64.zip",
    sha256: "c6b9b3d9184fc08c33fb8b181d9f241d8f5d61162a0be0521b6dfc1f11813a96",
  },
};
export { desktopCommand, safeEnvironment } from "./connector-process.js";
export function connectorConfig(config: unknown): {
  gatewayPort: number;
  ngrokApiPort: number;
  tunnel?: ConnectorTunnel;
} {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (k) => !["version", "gatewayPort", "ngrokApiPort", "tunnel"].includes(k),
    ) ||
    ("version" in config && config.version !== 1)
  )
    throw new Error(
      "Invalid connector config; allowed fields: version: 1, gatewayPort, ngrokApiPort, tunnel. Secrets belong in process environment or project .env.",
    );
  const c = config as { gatewayPort?: number; ngrokApiPort?: number; tunnel?: string };
  if (c.tunnel !== undefined && !["ngrok", "cloudflare"].includes(c.tunnel))
    throw new Error("Connector tunnel must be ngrok or cloudflare.");
  const gatewayPort = c.gatewayPort ?? 8787,
    ngrokApiPort = c.ngrokApiPort ?? 4041;
  if (
    ![gatewayPort, ngrokApiPort].every(
      (p) => Number.isInteger(p) && p >= 1024 && p <= 65535,
    ) ||
    gatewayPort === ngrokApiPort
  )
    throw new Error(
      "Invalid connector ports; use distinct ports from 1024 to 65535.",
    );
  return { gatewayPort, ngrokApiPort, ...(c.tunnel === "cloudflare" ? { tunnel: "cloudflare" as const } : {}) };
}
async function readConfig(root: string) {
  try {
    return connectorConfig(
      JSON.parse(
        await readFile(join(root, ".devos/connector/config.json"), "utf8"),
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return connectorConfig({});
    throw new Error(
      "Invalid .devos/connector/config.json; use version: 1, tunnel and non-secret ports only.",
    );
  }
}
async function checkDesktop() {
  try {
    const pkg = JSON.parse(
      await readFile(
        join(
          softwareRoot,
          "node_modules/@wonderwhy-er/desktop-commander/package.json",
        ),
        "utf8",
      ),
    );
    if (pkg.version !== DESKTOP_VERSION) throw new Error();
    await access(desktopCommand(softwareRoot).args[0]!);
  } catch {
    throw new Error(
      `Missing/stale Desktop Commander ${DESKTOP_VERSION}; run ./devos connector setup.`,
    );
  }
}
async function checkedVersion(binary: string) {
  const result = spawnSync(binary, ["version"], {
    env: safeEnvironment(process.env),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (
    result.status !== 0 ||
    result.stdout.trim() !== `ngrok version ${NGROK_VERSION}`
  )
    throw new Error(
      `Missing/stale ngrok ${NGROK_VERSION}; run ./devos connector setup.`,
    );
  try {
    const receipt = JSON.parse(await readFile(binary + ".json", "utf8"));
    if (
      receipt.version !== NGROK_VERSION ||
      receipt.sha256 !==
        createHash("sha256")
          .update(await readFile(binary))
          .digest("hex")
    )
      throw new Error();
  } catch {
    throw new Error(
      "ngrok integrity check failed; run ./devos connector setup.",
    );
  }
}
async function installNgrok(root: string) {
  const release = releases[process.platform + "-" + process.arch];
  if (!release)
    throw new Error(
      "Project-local ngrok setup currently supports macOS arm64/x64 only.",
    );
  const tools = join(root, ".devos/tools");
  await mkdir(tools, { recursive: true, mode: 0o700 });
  const zip = join(tools, "ngrok-download.zip"),
    stage = join(tools, "ngrok-install"),
    binary = join(tools, "ngrok");
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { mode: 0o700 });
  try {
    const response = await fetch(release.url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== release.sha256)
      throw new Error();
    await writeFile(zip, bytes, { mode: 0o600 });
    const extract = spawnSync(
      "/usr/bin/unzip",
      ["-q", zip, "ngrok", "-d", stage],
      { env: safeEnvironment(process.env), stdio: "ignore", timeout: 10_000 },
    );
    if (extract.status !== 0) throw new Error();
    await chmod(join(stage, "ngrok"), 0o700);
    await rename(join(stage, "ngrok"), binary);
    await writeFile(
      binary + ".json",
      JSON.stringify({
        version: NGROK_VERSION,
        sha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
      }) + "\n",
      { mode: 0o600 },
    );
    await checkedVersion(binary);
  } catch {
    throw new Error(
      "Pinned ngrok installation failed (download/checksum/extraction/version); no credentials were used.",
    );
  } finally {
    await rm(zip, { force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
export function lockPort(identity: string) {
  return (
    20000 +
    (createHash("sha256").update(identity).digest().readUInt32BE(0) % 40000)
  );
}
async function acquire(identity: string) {
  const lock = createServer((socket) => socket.destroy());
  await new Promise<void>((ok, fail) => {
    lock.once("error", () =>
      fail(
        new Error(
          "Duplicate active connector (or occupied lock port); stop the foreground connector before retrying.",
        ),
      ),
    );
    lock.listen(
      { host: "127.0.0.1", port: lockPort(identity), exclusive: true },
      ok,
    );
  });
  return lock;
}
export function ngrokArgs(root: string, port: number) {
  return [
    "http",
    `http://127.0.0.1:${port}`,
    "--config",
    join(root, ".devos/connector/ngrok.yml"),
    "--log=false",
    "--inspect=false",
  ];
}
async function publicEndpoint(
  apiPort: number,
  gatewayPort: number,
): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    const data = (await response.json()) as {
      tunnels?: { public_url?: string; config?: { addr?: string } }[];
    };
    const endpoint = data.tunnels?.find(
      (t) =>
        t.config?.addr === `http://127.0.0.1:${gatewayPort}` &&
        t.public_url?.startsWith("https://"),
    )?.public_url;
    return endpoint ? publicIdentity(endpoint).href : undefined;
  } catch {
    return undefined;
  }
}
export function cloudflareQuickTunnelUrl(output: string): string | undefined {
  // cloudflared writes the public URL to stderr; never trust arbitrary hosts.
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=\/|\s|$|[)\]\x7d,;|])/i);
  return match ? publicIdentity(match[0]).href : undefined;
}

async function tunnelEndpoint(
  config: { gatewayPort: number; ngrokApiPort: number; tunnel?: ConnectorTunnel },
  stateUrl?: string,
): Promise<string | undefined> {
  if (config.tunnel !== "cloudflare")
    return publicEndpoint(config.ngrokApiPort, config.gatewayPort);
  // Unlike ngrok, Quick Tunnel has no local discovery API. A URL is valid
  // only while the owned runtime and its local gateway are alive; this
  // does not prove that Cloudflare's public edge is reachable.
  return stateUrl && cloudflareQuickTunnelUrl(stateUrl) === stateUrl ? stateUrl : undefined;
}

async function checkCloudflared() {
  const result = spawnSync("cloudflared", ["--version"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16_384,
    env: safeEnvironment(process.env),
  });
  if (result.status !== 0 || !result.stdout.startsWith("cloudflared version "))
    throw new Error("Missing cloudflared; install the official Cloudflare Tunnel CLI.");
}

async function health(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const state = (await response.json()) as {
      gatewayReady?: unknown;
      backendAlive?: unknown;
    };
    return state.gatewayReady === true && state.backendAlive === true;
  } catch {
    return false;
  }
}
export interface ConnectorStatusSnapshot {
  lifecycle: string;
  supervisor: string;
  runtimeAlive: boolean;
  localHealthy: boolean;
  ngrokRegistered: boolean;
  tunnel?: ConnectorTunnel;
  restartAttempt?: number;
  maxRestartAttempts?: number;
  lastFailureComponent?: string;
  lastFailureAt?: string;
  lastExitCode?: number | null;
}

export function formatConnectorStatus(snapshot: ConnectorStatusSnapshot): string {
  const restart =
    snapshot.restartAttempt !== undefined &&
    snapshot.maxRestartAttempts !== undefined
      ? `; restart ${snapshot.restartAttempt}/${snapshot.maxRestartAttempts}`
      : "";
  const failure = snapshot.lastFailureComponent
    ? `; last failure ${snapshot.lastFailureComponent}${snapshot.lastExitCode !== undefined ? ` exit=${snapshot.lastExitCode}` : ""}${snapshot.lastFailureAt ? ` at ${snapshot.lastFailureAt}` : ""}`
    : "";
  return (
    `Connector ${snapshot.lifecycle}; supervisor ${snapshot.supervisor}; runtime ${snapshot.runtimeAlive ? "running" : "stopped"}; ` +
    `local gateway ${snapshot.localHealthy ? "healthy" : "unavailable"}; ${snapshot.tunnel ?? "ngrok"} ${snapshot.ngrokRegistered ? "HTTPS endpoint registered" : "unavailable"}` +
    `${restart}${failure}; public reachability not tested.\n`
  );
}

const backgroundStateName = "background.json";

export interface ConnectorBackgroundState {
  pid?: number;
  startedAt?: string;
  projectRoot?: string;
  ownershipToken?: string;
  identity?: ProcessIdentity;
}

async function backgroundState(root: string): Promise<ConnectorBackgroundState> {
  try {
    return JSON.parse(
      await readFile(join(root, ".devos/connector", backgroundStateName), "utf8"),
    ) as ConnectorBackgroundState;
  } catch {
    return {};
  }
}

export function backgroundOwnershipIsProvable(
  state: ConnectorBackgroundState,
  root: string,
): state is ConnectorBackgroundState & {
  pid: number;
  projectRoot: string;
  identity: ProcessIdentity;
} {
  return (
    Number.isSafeInteger(state.pid) &&
    !!state.pid &&
    state.pid > 0 &&
    state.projectRoot === root &&
    !!state.identity &&
    state.identity.pid === state.pid
  );
}

export function backgroundOwnershipMatches(
  state: ConnectorBackgroundState,
  actual: ProcessIdentity,
  root: string,
): boolean {
  return (
    backgroundOwnershipIsProvable(state, root) &&
    state.pid === actual.pid &&
    sameProcessIdentity(state.identity, actual)
  );
}

function processAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid! <= 0) return false;
  try {
    process.kill(pid!, 0);
    return true;
  } catch {
    return false;
  }
}

export async function connectorBackgroundRunning(root: string): Promise<boolean> {
  root = await realpath(root);
  const state = await backgroundState(root);
  if (!processAlive(state.pid) || !state.pid) return false;
  const actual = await captureProcessIdentity(state.pid);
  return !!actual && backgroundOwnershipMatches(state, actual, root);
}

async function startBackground(root: string, config: {
  gatewayPort: number;
  ngrokApiPort: number;
  tunnel?: ConnectorTunnel;
}, secrets: ConnectorSecrets) {
  const dir = join(root, ".devos/connector");
  const serviceFile = join(dir, backgroundStateName);
  const existing = await backgroundState(root);
  if (processAlive(existing.pid) && existing.pid) {
    if (!backgroundOwnershipIsProvable(existing, root)) {
      throw new Error(
        "Cannot prove ownership of the existing DevOS background PID; refusing to replace its state.",
      );
    }
    const actual = await captureProcessIdentity(existing.pid);
    if (!actual) {
      throw new Error("Cannot inspect the existing DevOS background PID; refusing to replace its state.");
    }
    if (backgroundOwnershipMatches(existing, actual, root)) {
      process.stdout.write("DevOS is already running in background.\n");
      return;
    }
    await rm(serviceFile, { force: true });
  } else {
    await rm(serviceFile, { force: true });
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const runner = join(softwareRoot, "dist/src/connector-runner.js");
  await access(runner);
  const child = spawn(process.execPath, [runner, root, "--background"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...safeEnvironment(process.env),
      NGROK_AUTHTOKEN: secrets.ngrokAuthtoken,
      DEVOS_CONNECTOR_OWNER_SECRET: secrets.ownerSecret,
    },
  });
  const childIdentity = child.pid ? await captureProcessIdentity(child.pid) : null;
  if (!child.pid || !childIdentity) {
    child.kill("SIGTERM");
    throw new Error("DevOS could not prove ownership of the background connector process.");
  }
  await writeFile(
    serviceFile,
    JSON.stringify({
      pid: child.pid,
      startedAt: new Date().toISOString(),
      projectRoot: root,
      ownershipToken: randomUUID(),
      identity: childIdentity,
    }) + "\n",
    { mode: 0o600 },
  );
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!processAlive(child.pid)) break;
    let connectorState: { publicUrl?: string } = {};
    try {
      connectorState = JSON.parse(
        await readFile(join(dir, "state.json"), "utf8"),
      ) as { publicUrl?: string };
    } catch {}
    const local = await health(config.gatewayPort);
    const publicUrl = local
      ? await tunnelEndpoint(config, connectorState.publicUrl)
      : undefined;
    if (
      publicUrl &&
      connectorState.publicUrl === publicUrl
    ) {
      process.stdout.write(
        `DevOS background ready: ${new URL("/mcp", publicUrl).href}\nYou can close this terminal.\n`,
      );
      return;
    }
    await delay(100);
  }

  if (processAlive(child.pid)) {
    const actual = child.pid ? await captureProcessIdentity(child.pid) : null;
    if (actual && sameProcessIdentity(childIdentity, actual)) {
      try {
        process.kill(child.pid!, "SIGTERM");
      } catch {}
    }
  }
  await rm(serviceFile, { force: true });
  throw new Error("DevOS background startup failed.");
}

async function stopBackground(root: string) {
  const dir = join(root, ".devos/connector");
  const serviceFile = join(dir, backgroundStateName);
  const state = await backgroundState(root);
  if (!processAlive(state.pid) || !state.pid) {
    await rm(serviceFile, { force: true });
    process.stdout.write("DevOS background is already stopped.\n");
    return;
  }
  if (!backgroundOwnershipIsProvable(state, root)) {
    throw new Error(
      "Cannot prove DevOS background process ownership from stored state; refusing to signal or remove it.",
    );
  }
  const actual = await captureProcessIdentity(state.pid);
  if (!actual) {
    throw new Error("Cannot inspect DevOS background process ownership; refusing to signal the stored PID.");
  }
  if (!backgroundOwnershipMatches(state, actual, root)) {
    await rm(serviceFile, { force: true });
    process.stdout.write("DevOS background ownership state was stale; no process was signaled.\n");
    return;
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch {}
  const gracefulDeadline = Date.now() + 5000;
  while (processAlive(state.pid) && Date.now() < gracefulDeadline) {
    await delay(50);
  }
  if (processAlive(state.pid)) {
    const afterGrace = await captureProcessIdentity(state.pid);
    if (!afterGrace || !backgroundOwnershipMatches(state, afterGrace, root)) {
      throw new Error(
        "DevOS background PID changed identity during shutdown; refusing SIGKILL escalation.",
      );
    }
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {}
  }

  const cleanupDeadline = Date.now() + 3000;
  while (Date.now() < cleanupDeadline) {
    let runtime: { pid?: number } = {};
    try {
      runtime = JSON.parse(
        await readFile(join(dir, "state.json"), "utf8"),
      ) as { pid?: number };
    } catch {}
    if (!processAlive(runtime.pid)) break;
    await delay(50);
  }
  await rm(serviceFile, { force: true });
  process.stdout.write("DevOS background stopped; owned connector processes cleaned up.\n");
}

async function superviseRun(root: string, secrets: ConnectorSecrets) {
  const runner = join(softwareRoot, "dist/src/connector-runner.js");
  await access(runner);
  const child = spawn(process.execPath, [runner, root], {
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...safeEnvironment(process.env),
      NGROK_AUTHTOKEN: secrets.ngrokAuthtoken,
      DEVOS_CONNECTOR_OWNER_SECRET: secrets.ownerSecret,
    },
  });
  const stop = () => {
    child.stdin?.end();
    child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.stdin?.on("error", () => {});
  try {
    const code = await new Promise<number | null>((ok) => {
      child.once("error", () => ok(-1));
      child.once("close", ok);
    });
    if (code !== 0)
      throw new Error(
        "Connector foreground runner failed; check local diagnostics.",
      );
  } finally {
    child.stdin?.end();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function runtimeGroupChildren(): number[] | undefined {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
  if (result.status !== 0 || result.error) return undefined;
  return result.stdout
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      return match && Number(match[2]) === process.pid && Number(match[1]) !== process.pid
        ? [Number(match[1])]
        : [];
    });
}

async function cleanupRuntimeGroupChildren() {
  let children = runtimeGroupChildren();
  if (!children) return;
  for (const pid of children) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const gracefulDeadline = Date.now() + 3_000;
  while (Date.now() < gracefulDeadline) {
    children = runtimeGroupChildren();
    if (!children?.length) return;
    await delay(25);
  }
  children = runtimeGroupChildren();
  for (const pid of children ?? []) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  const forcedDeadline = Date.now() + 1_000;
  while (Date.now() < forcedDeadline) {
    children = runtimeGroupChildren();
    if (!children?.length) return;
    await delay(25);
  }
}

export async function connector(
  action: ConnectorAction,
  root: string,
  ownerLifetime?: Readable,
  // Direct foreground callers may replace only the retry clock for deterministic
  // lifecycle tests. The CLI/background runner never supplies this override.
  supervisorOptions: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  root = await realpath(root);
  const binary = join(root, ".devos/tools/ngrok"),
    dir = join(root, ".devos/connector"),
    stateFile = join(dir, "state.json");
  if (action === "setup") {
    try {
      await checkDesktop();
    } catch {
      const npm = spawnSync("npm", ["ci", "--ignore-scripts"], {
        cwd: softwareRoot,
        env: safeEnvironment(process.env),
        stdio: "ignore",
      });
      if (npm.status !== 0)
        throw new Error("Desktop Commander dependency install failed.");
      await checkDesktop();
    }
    if ((await readConfig(root)).tunnel !== "cloudflare") {
      try {
        await checkedVersion(binary);
      } catch {
        await installNgrok(root);
      }
    } else await checkCloudflared();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    process.stdout.write(
      `Connector software ready: Desktop Commander ${DESKTOP_VERSION}, ${(await readConfig(root)).tunnel}.\n`,
    );
    return;
  }
  const config = await readConfig(root);
  if (action === "stop") {
    await stopBackground(root);
    return;
  }
  if (action === "status") {
    let state: { pid?: number; publicUrl?: string; lifecycle?: string; restartAttempt?: number; maxRestartAttempts?: number; lastFailureComponent?: string; lastFailureAt?: string; lastExitCode?: number | null } = {};
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch {}
    let alive = false;
    if (Number.isSafeInteger(state.pid) && state.pid! > 0) {
      try {
        process.kill(state.pid!, 0);
        alive = true;
      } catch {}
    }
    const local = alive && (await health(config.gatewayPort));
    const url = alive && local
      ? await tunnelEndpoint(config, state.publicUrl)
      : undefined;
    const background = await backgroundState(root);
    let supervisor = "foreground-or-absent";
    if (background.pid && processAlive(background.pid)) {
      const actual = await captureProcessIdentity(background.pid);
      supervisor = actual && backgroundOwnershipMatches(background, actual, root)
        ? "owned"
        : "invalid";
    } else if (background.pid) {
      supervisor = "stale";
    }
    // Do not probe public tool endpoints or claim external reachability from local agent state.
    process.stdout.write(formatConnectorStatus({
      lifecycle: state.lifecycle ?? (alive ? "degraded" : "stopped"),
      supervisor,
      runtimeAlive: alive,
      localHealthy: local,
      ngrokRegistered: !!url && url === state.publicUrl,
      ...(config.tunnel ? { tunnel: config.tunnel } : {}),
      ...(state.restartAttempt !== undefined ? { restartAttempt: state.restartAttempt } : {}),
      ...(state.maxRestartAttempts !== undefined ? { maxRestartAttempts: state.maxRestartAttempts } : {}),
      ...(state.lastFailureComponent ? { lastFailureComponent: state.lastFailureComponent } : {}),
      ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
      ...(state.lastExitCode !== undefined ? { lastExitCode: state.lastExitCode } : {}),
    }));
    return;
  }
  if (action === "start") {
    try {
      await checkDesktop();
      await checkedVersion(binary);
    } catch {
      await connector("setup", root);
    }
  }
  await checkDesktop();
  if (config.tunnel !== "cloudflare") await checkedVersion(binary);
  else await checkCloudflared();
  const secrets = await loadConnectorSecrets(root);
  ownerAuth(secrets.ownerSecret);
  if (action === "start") {
    await startBackground(root, config, secrets);
    return;
  }
  if (action === "doctor") {
    const lock = await acquire(root);
    await new Promise<void>((ok) => lock.close(() => ok()));
    process.stdout.write(
      `Local software/config/auth present. ${config.tunnel} public connectivity not tested.\n`,
    );
    return;
  }
  if (!ownerLifetime) {
    await superviseRun(root, secrets);
    return;
  }
  const lock = await acquire(root);
  const abort = new AbortController();
  let terminalFailed = false;
  let currentPid: number | undefined;
  let currentRuntime: ReturnType<typeof spawn> | undefined;
  let currentPublicUrl: string | undefined;
  let announcedReady = false;
  const stop = () => abort.abort();
  ownerLifetime.once("end", stop);
  ownerLifetime.once("error", stop);
  ownerLifetime.resume();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const runtimeGroupAlive = (
    runtime: ReturnType<typeof spawn> | undefined,
  ): boolean => {
    if (!runtime?.pid) return false;
    try {
      process.kill(-runtime.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signalRuntimeGroup = (
    runtime: ReturnType<typeof spawn> | undefined,
    signal: NodeJS.Signals,
  ) => {
    if (!runtime?.pid) return;
    try { process.kill(-runtime.pid, signal); } catch {}
  };

  const persistSupervisorState = async (
    state: ConnectorSupervisorState,
    ready?: { pid: number; publicUrl: string },
  ) => {
    if (ready) {
      currentPid = ready.pid;
      currentPublicUrl = ready.publicUrl;
    }
    terminalFailed = state.status === "terminal_failed";
    await appendConnectorDiagnostic(root, state);
    await writeFile(
      stateFile,
      JSON.stringify({
        pid: currentPid,
        publicUrl: currentPublicUrl,
        lifecycle: state.status,
        restartAttempt: state.restartAttempt,
        maxRestartAttempts: state.maxRestartAttempts,
        ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
        ...(state.lastFailureComponent ? { lastFailureComponent: state.lastFailureComponent } : {}),
        ...(state.lastExitCode !== undefined ? { lastExitCode: state.lastExitCode } : {}),
        ...(state.lastExitSignal !== undefined ? { lastExitSignal: state.lastExitSignal } : {}),
        ...(state.lastFailureMessage ? { lastFailureMessage: state.lastFailureMessage } : {}),
      }) + "\n",
      { mode: 0o600 },
    );
  };

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await runBoundedConnectorSupervisor({
      signal: abort.signal,
      ...(supervisorOptions.sleep ? { sleep: supervisorOptions.sleep } : {}),
      onState: persistSupervisorState,
      onHealthy: async ({ publicUrl }) => {
        if (!announcedReady) {
          announcedReady = true;
          process.stdout.write(
            `Connector ready: ${new URL("/mcp", publicUrl).href}. OAuth required. Foreground; Ctrl+C stops gateway, tunnel and Desktop Commander.\n`,
          );
        }
      },
      launch: async () => {
        const runtime = spawn(
          process.execPath,
          [join(softwareRoot, "dist/src/connector-runtime.js"), root],
          {
            detached: true,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {
              ...safeEnvironment(process.env),
              NGROK_AUTHTOKEN: secrets.ngrokAuthtoken,
              DEVOS_CONNECTOR_OWNER_SECRET: secrets.ownerSecret,
            },
          },
        );
        currentRuntime = runtime;
        currentPid = runtime.pid;
        currentPublicUrl = undefined;
        let failure: { component?: string; message?: string } | undefined;
        runtime.on("message", message => {
          if (
            typeof message === "object" &&
            message &&
            "failure" in message &&
            typeof message.failure === "object" &&
            message.failure
          ) {
            const record = message.failure as { component?: unknown; message?: unknown };
            failure = {
              ...(typeof record.component === "string" ? { component: record.component } : {}),
              ...(typeof record.message === "string" ? { message: record.message } : {}),
            };
          }
        });
        const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; component?: string; message?: string }>((ok) => {
          runtime.once("error", () => ok({ code: -1, signal: null, ...(failure ?? {}) }));
          runtime.once("exit", (code, signal) => ok({ code, signal, ...(failure ?? {}) }));
        });
        const ready = new Promise<{ pid: number; publicUrl: string }>((ok, fail) => {
          const timeout = setTimeout(
            () => fail(new Error("Connector startup timed out.")),
            30_000,
          );
          runtime.on("message", message => {
            if (
              typeof message === "object" &&
              message &&
              "publicUrl" in message &&
              typeof message.publicUrl === "string"
            ) {
              try {
                const publicUrl = publicIdentity(message.publicUrl).href;
                clearTimeout(timeout);
                ok({ pid: runtime.pid!, publicUrl });
              } catch {}
            }
          });
          void exit.then(result => {
            clearTimeout(timeout);
            fail(Object.assign(
              new Error(result.message ?? "Connector startup/runtime failed; check local ports, ngrok credentials and Desktop Commander."),
              {
                exitCode: result.code,
                exitSignal: result.signal,
                component: result.component,
              },
            ));
          });
        });
        return {
          ready,
          exit,
          stop: (signal: NodeJS.Signals = "SIGTERM") => signalRuntimeGroup(runtime, signal),
        };
      },
    });
  } finally {
    abort.abort();
    signalRuntimeGroup(currentRuntime, "SIGTERM");
    const shutdownDeadline = Date.now() + 3000;
    while (
      runtimeGroupAlive(currentRuntime) &&
      Date.now() < shutdownDeadline
    ) await delay(25);
    if (runtimeGroupAlive(currentRuntime)) {
      signalRuntimeGroup(currentRuntime, "SIGKILL");
    }
    if (!terminalFailed) await rm(stateFile, { force: true });
    await rm(join(dir, "ngrok.yml"), { force: true });
    await new Promise<void>(ok => lock.close(() => ok()));
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    ownerLifetime.off("end", stop);
    ownerLifetime.off("error", stop);
  }
}

export async function connectorRuntime(root: string) {
  const config = await readConfig(root);
  const dir = join(root, ".devos/connector");
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>(resolve => {
    resolveStop = resolve;
  });
  let stopping = false,
    parentDisconnected = false,
    failureComponent: "desktop_commander" | "ngrok" | "runtime" | undefined,
    child: ReturnType<typeof spawn> | undefined,
    gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    resolveStop();
    child?.kill("SIGTERM");
    void gateway?.close().catch(() => {});
  };
  const parentDisconnect = () => {
    parentDisconnected = true;
    stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("disconnect", parentDisconnect);
  try {
    try {
      gateway = await startGateway({
      root: softwareRoot,
      chatAccessRoot: root,
      port: config.gatewayPort,
      jsonResponseOnly: config.tunnel === "cloudflare",
      ownerSecret: ownerAuth(process.env.DEVOS_CONNECTOR_OWNER_SECRET),
      oauthClientsPath: join(root, ".devos/connector/oauth-clients.json"),
      oauthStatePath: join(root, ".devos/connector/oauth-state.enc"),
      onFailure: component => {
        failureComponent = component;
        stop();
      },
      onDiagnostic: record => appendDesktopCommanderDiagnostic(root, record),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Gateway startup failed.");
      throw Object.assign(failure, {
        component: /Desktop Commander/i.test(failure.message)
          ? "desktop_commander"
          : "gateway",
      });
    }
    if (stopping && failureComponent) {
      throw Object.assign(new Error("Desktop Commander transport closed unexpectedly."), {
        component: failureComponent,
      });
    }
    if (stopping) return;
    let exited = false;
    let url: string | undefined;
    if (config.tunnel !== "cloudflare") {
      await writeFile(
        join(dir, "ngrok.yml"),
        `version: "2"\nweb_addr: 127.0.0.1:${config.ngrokApiPort}\nconsole_ui: false\nupdate_check: false\n`,
        { mode: 0o600 },
      );
      child = spawn(join(root, ".devos/tools/ngrok"), ngrokArgs(root, config.gatewayPort), {
        cwd: root, stdio: "ignore",
        env: { ...safeEnvironment(process.env), NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN },
      });
    } else {
      // Quick Tunnel for staging: random hostname, no Cloudflare credentials.
      // Limit read bytes; do not forward cloudflared logs or secrets.
      child = spawn("cloudflared",
        ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${config.gatewayPort}`],
        { cwd: root, stdio: ["ignore", "ignore", "pipe"],
          env: safeEnvironment(process.env) },
      );
      let captured = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        captured = (captured + chunk.toString("utf8")).slice(-16_384);
        url ??= cloudflareQuickTunnelUrl(captured);
      });
    }
    const exit = new Promise<void>(ok => {
      child!.once("error", () => { exited = true; ok(); });
      child!.once("exit", () => { exited = true; ok(); });
    });
    const deadline = Date.now() + 25_000;
    while (!stopping && !exited && Date.now() < deadline) {
      if (config.tunnel !== "cloudflare")
        url = await publicEndpoint(config.ngrokApiPort, config.gatewayPort);
      if (url) break;
      await delay(100);
    }
    if (!url || stopping || exited) {
      const component = failureComponent ?? (config.tunnel ?? "ngrok");
      throw Object.assign(
        new Error(component === "desktop_commander"
          ? "Desktop Commander transport closed unexpectedly."
          : `${config.tunnel} startup/registration failed.`),
        { component },
      );
    }
    gateway.setPublicUrl(url);
    process.send?.({ publicUrl: url });
    await Promise.race([exit, stopRequested]);
    if (!stopping) {
      throw Object.assign(new Error(`${config.tunnel} exited unexpectedly.`), {
        component: config.tunnel ?? "ngrok",
      });
    }
    if (failureComponent) {
      throw Object.assign(new Error("Connector child transport exited unexpectedly."), {
        component: failureComponent,
      });
    }
  } finally {
    stop();
    await gateway?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      await Promise.race([
        new Promise<void>(resolve => child!.once("exit", () => resolve())),
        delay(3000),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          new Promise<void>(resolve => child!.once("exit", () => resolve())),
          delay(1000),
        ]);
      }
    }
    if (parentDisconnected) await cleanupRuntimeGroupChildren();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("disconnect", parentDisconnect);
  }
}
