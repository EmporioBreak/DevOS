import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  startGateway,
  ownerAuth,
  publicIdentity,
} from "./connector-gateway.js";
export { startGateway } from "./connector-gateway.js";
export const NGROK_VERSION = "3.39.11";
export const DESKTOP_VERSION = "0.2.52";
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
export function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG"])
    if (env[key]) out[key] = env[key];
  return out;
}

function projectIdentity(root: string) {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

async function atomicWrite(path: string, content: string) {
  const tmp = path + "." + process.pid + ".tmp";
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function keychain(root: string, account: string, value?: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const service = "devos.connector." + projectIdentity(root);
  const args = value === undefined
    ? ["find-generic-password", "-a", account, "-s", service, "-w"]
    : ["add-generic-password", "-U", "-a", account, "-s", service, "-w"];
  const result = spawnSync("/usr/bin/security", args, {
    // With -w and no argv value, macOS security prompts twice for a new/updated
    // password. Feed both confirmations through stdin so the secret never
    // appears in argv/process listings.
    input: value === undefined ? undefined : value + "\n" + value + "\n",
    encoding: "utf8",
    env: safeEnvironment(process.env),
    stdio: value === undefined ? ["ignore", "pipe", "ignore"] : ["pipe", "ignore", "ignore"],
  });
  return result.status === 0 && value === undefined ? result.stdout.trim() : result.status === 0 ? "" : undefined;
}

function importCredentials(root: string) {
  for (const [envName, account] of [
    ["DEVOS_CONNECTOR_OWNER_SECRET", "owner-secret"],
    ["NGROK_AUTHTOKEN", "ngrok-authtoken"],
  ] as const) {
    const value = process.env[envName]?.trim();
    if (value && keychain(root, account, value) === undefined)
      throw new Error(`Could not store ${envName} in macOS Keychain.`);
  }
}

function loadCredentials(root: string) {
  if (!process.env.DEVOS_CONNECTOR_OWNER_SECRET) {
    const value = keychain(root, "owner-secret");
    if (value) process.env.DEVOS_CONNECTOR_OWNER_SECRET = value;
  }
  if (!process.env.NGROK_AUTHTOKEN) {
    const value = keychain(root, "ngrok-authtoken");
    if (value) process.env.NGROK_AUTHTOKEN = value;
  }
}

async function secureStatePermissions(dir: string) {
  for (const name of [
    "background.json",
    "state.json",
    "supervisor.json",
    "diagnostic.json",
    "auth-diagnostic.json",
    "oauth-state.enc",
    "oauth-clients.json",
    "ngrok.yml",
  ]) {
    try { await chmod(join(dir, name), 0o600); } catch {}
  }
}
export function desktopCommand(root: string) {
  return {
    file: process.execPath,
    args: [
      join(root, "node_modules/@wonderwhy-er/desktop-commander/dist/index.js"),
      "--no-onboarding",
    ],
  };
}
export function connectorConfig(config: unknown): {
  gatewayPort: number;
  ngrokApiPort: number;
} {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (k) => !["version", "gatewayPort", "ngrokApiPort"].includes(k),
    ) ||
    ("version" in config && config.version !== 1)
  )
    throw new Error(
      "Invalid connector config; allowed fields: version: 1, gatewayPort, ngrokApiPort. Secrets stay environment-only.",
    );
  const c = config as { gatewayPort?: number; ngrokApiPort?: number };
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
  return { gatewayPort, ngrokApiPort };
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
      "Invalid .devos/connector/config.json; use version: 1 and non-secret ports only.",
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

export function ngrokFailureReason(stderr: string) {
  const bounded = stderr.slice(0, 8192).toLowerCase();
  if (
    /authentication\s+failed/.test(bounded) ||
    /authtoken[^\n]{0,120}(invalid|not valid|rejected|unauthori[sz]ed)/.test(
      bounded,
    ) ||
    /(invalid|rejected|unauthori[sz]ed)[^\n]{0,120}authtoken/.test(bounded)
  )
    return "ngrok credential rejected.";
  return "ngrok exited unexpectedly.";
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
async function health(port: number) {
  try {
    return (
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      })
    ).ok;
  } catch {
    return false;
  }
}
const backgroundStateName = "background.json";

type BackgroundState = {
  pid?: number;
  identity?: string;
  fingerprint?: string;
  startedAt?: string;
};
type RuntimeState = {
  pid?: number;
  identity?: string;
  fingerprint?: string;
  publicUrl?: string;
};
async function backgroundState(root: string): Promise<BackgroundState> {
  try {
    return JSON.parse(
      await readFile(join(root, ".devos/connector", backgroundStateName), "utf8"),
    ) as BackgroundState;
  } catch {
    return {};
  }
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

function processCommand(pid: number | undefined): string | undefined {
  if (!processAlive(pid)) return undefined;
  const ps = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env: safeEnvironment(process.env),
  });
  return ps.status === 0 ? ps.stdout.trim() : undefined;
}

function processFingerprint(pid: number | undefined): string | undefined {
  if (!processAlive(pid)) return undefined;
  const ps = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: safeEnvironment(process.env),
  });
  return ps.status === 0 && ps.stdout.trim() ? ps.stdout.trim() : undefined;
}

function ownedCommand(
  root: string,
  pid: number | undefined,
  identity: string | undefined,
  fingerprint: string | undefined,
  executableMarker: string,
  extraMarker?: string,
): boolean {
  const command = processCommand(pid);
  const commandMatches =
    !!command &&
    command.includes(executableMarker) &&
    command.includes(root) &&
    (!extraMarker || command.includes(extraMarker));
  if (!commandMatches) return false;

  // Legacy pre-#77 state had only a PID. Permit one-time migration only when
  // both new identity fields are absent and the live command line proves this
  // is the expected project-local connector process. New state must match both.
  if (identity === undefined && fingerprint === undefined) return true;
  return (
    identity === projectIdentity(root) &&
    !!fingerprint &&
    processFingerprint(pid) === fingerprint
  );
}

function backgroundOwned(root: string, state: BackgroundState): boolean {
  return ownedCommand(
    root,
    state.pid,
    state.identity,
    state.fingerprint,
    "connector-runner",
    "--background",
  );
}

export async function connectorBackgroundRunning(root: string): Promise<boolean> {
  root = await realpath(root);
  return backgroundOwned(root, await backgroundState(root));
}

async function startBackground(root: string, config: {
  gatewayPort: number;
  ngrokApiPort: number;
}) {
  const dir = join(root, ".devos/connector");
  const serviceFile = join(dir, backgroundStateName);
  const existing = await backgroundState(root);
  if (backgroundOwned(root, existing)) {
    process.stdout.write("DevOS is already running in background.\n");
    return;
  }
  await rm(serviceFile, { force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await cleanupOwnedRuntime(root);

  const runner = join(softwareRoot, "dist/src/connector-runner.js");
  await access(runner);
  const child = spawn(process.execPath, [runner, root, "--background"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...safeEnvironment(process.env),
      NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
      DEVOS_CONNECTOR_OWNER_SECRET: process.env.DEVOS_CONNECTOR_OWNER_SECRET,
    },
  });
  const backgroundFingerprint = processFingerprint(child.pid);
  if (!backgroundFingerprint) {
    try { process.kill(child.pid!, "SIGTERM"); } catch {}
    throw new Error("Could not establish background supervisor identity.");
  }
  await atomicWrite(
    serviceFile,
    JSON.stringify({
      pid: child.pid,
      identity: projectIdentity(root),
      fingerprint: backgroundFingerprint,
      startedAt: new Date().toISOString(),
    }) + "\n",
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
      ? await publicEndpoint(config.ngrokApiPort, config.gatewayPort)
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
    try {
      process.kill(child.pid!, "SIGTERM");
    } catch {}
  }
  await rm(serviceFile, { force: true });
  throw new Error("DevOS background startup failed.");
}

async function runtimeState(root: string): Promise<RuntimeState> {
  try {
    return JSON.parse(
      await readFile(join(root, ".devos/connector/state.json"), "utf8"),
    ) as RuntimeState;
  } catch {
    return {};
  }
}

function runtimeOwned(root: string, state: RuntimeState): boolean {
  return ownedCommand(
    root,
    state.pid,
    state.identity,
    state.fingerprint,
    "connector-runtime",
  );
}

async function cleanupOwnedRuntime(root: string) {
  const stateFile = join(root, ".devos/connector/state.json");
  const state = await runtimeState(root);
  if (!runtimeOwned(root, state)) {
    await rm(stateFile, { force: true });
    return;
  }
  try { process.kill(-state.pid!, "SIGTERM"); } catch {}
  const gracefulDeadline = Date.now() + 3000;
  while (runtimeOwned(root, state) && Date.now() < gracefulDeadline)
    await delay(50);
  if (runtimeOwned(root, state)) {
    try { process.kill(-state.pid!, "SIGKILL"); } catch {}
  }
  const killDeadline = Date.now() + 1000;
  while (runtimeOwned(root, state) && Date.now() < killDeadline)
    await delay(25);
  if (!runtimeOwned(root, state)) await rm(stateFile, { force: true });
}

async function stopBackground(root: string) {
  const dir = join(root, ".devos/connector");
  const serviceFile = join(dir, backgroundStateName);
  const state = await backgroundState(root);
  const supervisorOwned = backgroundOwned(root, state);
  const runtimeWasOwned = runtimeOwned(root, await runtimeState(root));

  if (supervisorOwned) {
    try {
      process.kill(state.pid!, "SIGTERM");
    } catch {}
    const gracefulDeadline = Date.now() + 5000;
    while (backgroundOwned(root, state) && Date.now() < gracefulDeadline) {
      await delay(50);
    }
    if (backgroundOwned(root, state)) {
      try {
        process.kill(state.pid!, "SIGKILL");
      } catch {}
    }
  }

  await cleanupOwnedRuntime(root);
  await rm(serviceFile, { force: true });
  await rm(join(dir, "supervisor.json"), { force: true });
  if (!supervisorOwned && !runtimeWasOwned)
    process.stdout.write("DevOS background is already stopped.\n");
  else
    process.stdout.write(
      "DevOS background stopped; owned connector processes cleaned up.\n",
    );
}

async function superviseRun(root: string) {
  const runner = join(softwareRoot, "dist/src/connector-runner.js");
  await access(runner);
  const child = spawn(process.execPath, [runner, root], {
    detached: true,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...safeEnvironment(process.env),
      NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
      DEVOS_CONNECTOR_OWNER_SECRET: process.env.DEVOS_CONNECTOR_OWNER_SECRET,
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
export async function connector(
  action: ConnectorAction,
  root: string,
  ownerLifetime?: Readable,
): Promise<void> {
  root = await realpath(root);
  const binary = join(root, ".devos/tools/ngrok"),
    dir = join(root, ".devos/connector"),
    stateFile = join(dir, "state.json");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await secureStatePermissions(dir);
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
    try {
      await checkedVersion(binary);
    } catch {
      await installNgrok(root);
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    importCredentials(root);
    process.stdout.write(
      `Connector software ready: Desktop Commander ${DESKTOP_VERSION}, ngrok ${NGROK_VERSION}.${process.env.DEVOS_CONNECTOR_OWNER_SECRET || process.env.NGROK_AUTHTOKEN ? " Supplied connector credentials stored in macOS Keychain." : ""}\n`,
    );
    return;
  }
  loadCredentials(root);
  const config = await readConfig(root);
  if (action === "stop") {
    await stopBackground(root);
    return;
  }
  if (action === "status") {
    let state: RuntimeState = {};
    let supervisor: { status?: string; attempt?: number } = {};
    let diagnostic: { layer?: string; reason?: string } = {};
    try { state = JSON.parse(await readFile(stateFile, "utf8")); } catch {}
    try { supervisor = JSON.parse(await readFile(join(dir, "supervisor.json"), "utf8")); } catch {}
    try { diagnostic = JSON.parse(await readFile(join(dir, "diagnostic.json"), "utf8")); } catch {}
    const owned = backgroundOwned(root, await backgroundState(root));
    const runtimeAlive = runtimeOwned(root, state);
    const local = runtimeAlive && (await health(config.gatewayPort));
    const url = runtimeAlive ? await publicEndpoint(config.ngrokApiPort, config.gatewayPort) : undefined;
    const healthy = owned && local && !!url && url === state.publicUrl;
    const phase = healthy ? "healthy" :
      supervisor.status === "failed" ? "failed" :
      supervisor.status === "recovering" ? "recovering" :
      owned ? (runtimeAlive ? "degraded" : "starting") :
      runtimeAlive && local ? "degraded" : "stopped";
    const detail = diagnostic.layer ? `; last failure ${diagnostic.layer}: ${diagnostic.reason ?? "unknown"}` : "";
    process.stdout.write(
      `Connector ${phase}; local gateway ${local ? "healthy" : "unavailable"}; ngrok ${url && url === state.publicUrl ? "HTTPS endpoint registered" : "unavailable"}${detail}; public reachability not tested.\n`,
    );
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
  await checkedVersion(binary);
  if (!process.env.DEVOS_CONNECTOR_OWNER_SECRET?.trim())
    throw new Error("Missing owner credential: run one-time connector setup with DEVOS_CONNECTOR_OWNER_SECRET set, or provide the environment override.");
  ownerAuth(process.env.DEVOS_CONNECTOR_OWNER_SECRET);
  if (!process.env.NGROK_AUTHTOKEN?.trim())
    throw new Error("Missing ngrok credential: run one-time connector setup with NGROK_AUTHTOKEN set, or provide the environment override.");
  if (action === "start") {
    await startBackground(root, config);
    return;
  }
  if (action === "doctor") {
    const lock = await acquire(root);
    await new Promise<void>((ok) => lock.close(() => ok()));
    process.stdout.write(
      "Local software/config/auth present. ngrok credentials and public connectivity not tested.\n",
    );
    return;
  }
  if (!ownerLifetime) {
    await superviseRun(root);
    return;
  }
  const lock = await acquire(root);
  // A separate foreground runtime owns one group: gateway + stdio + ngrok.
  // Runtime output is suppressed; only fixed IPC diagnostics/non-secret URL escape.
  let runtime: ReturnType<typeof spawn> | undefined;
  let exit: Promise<number | null> | undefined;
  let runtimeFailure: string | undefined;
  let stopping = false,
    deadline = 0,
    timer: NodeJS.Timeout | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (runtime?.pid) {
      try {
        process.kill(-runtime.pid, signal);
      } catch {}
    }
  };
  const alive = () => {
    if (!runtime?.pid) return false;
    try {
      process.kill(-runtime.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    deadline = Date.now() + 3000;
    signalGroup("SIGTERM");
    timer = setTimeout(() => signalGroup("SIGKILL"), 3000);
  };
  ownerLifetime.once("end", stop);
  ownerLifetime.once("error", stop);
  ownerLifetime.resume();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (stopping) return;
    runtime = spawn(
      process.execPath,
      [join(softwareRoot, "dist/src/connector-runtime.js"), root],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...safeEnvironment(process.env),
          NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
          DEVOS_CONNECTOR_OWNER_SECRET:
            process.env.DEVOS_CONNECTOR_OWNER_SECRET,
        },
      },
    );
    exit = new Promise<number | null>((ok) => {
      runtime!.once("error", () => ok(-1));
      runtime!.once("exit", ok);
    });
    const ready = new Promise<string>((ok, fail) => {
      const timeout = setTimeout(
        () => fail(new Error("Connector startup timed out.")),
        30_000,
      );
      runtime!.on("message", (message) => {
        if (typeof message !== "object" || !message) return;
        if (
          "failure" in message &&
          typeof message.failure === "string"
        ) {
          runtimeFailure = message.failure.slice(0, 512);
        }
        if (
          "publicUrl" in message &&
          typeof message.publicUrl === "string"
        ) {
          try {
            const url = publicIdentity(message.publicUrl);
            clearTimeout(timeout);
            ok(url.href);
          } catch {}
        }
      });
      void exit!.then(() => {
        clearTimeout(timeout);
        fail(
          new Error(
            runtimeFailure ??
              "Connector startup/runtime failed; check local ports, ngrok credentials and Desktop Commander.",
          ),
        );
      });
    });
    const runtimeFingerprint = processFingerprint(runtime.pid);
    if (!runtimeFingerprint)
      throw new Error("Could not establish connector runtime identity.");
    const runtimeIdentity = {
      pid: runtime.pid,
      identity: projectIdentity(root),
      fingerprint: runtimeFingerprint,
    };
    await atomicWrite(stateFile, JSON.stringify(runtimeIdentity) + "\n");
    const url = await ready;
    await atomicWrite(
      stateFile,
      JSON.stringify({ ...runtimeIdentity, publicUrl: url }) + "\n",
    );
    await atomicWrite(
      join(dir, "supervisor.json"),
      JSON.stringify({ version: 1, status: "healthy", updatedAt: new Date().toISOString() }) + "\n",
    );
    if (!stopping)
      process.stdout.write(
        `Connector ready: ${new URL("/mcp", url).href}. OAuth required. Foreground; Ctrl+C stops gateway, ngrok and Desktop Commander.\n`,
      );
    await exit;
    if (!stopping)
      throw new Error(runtimeFailure ?? "Connector runtime exited unexpectedly.");
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stop();
    while (alive() && Date.now() < deadline) await delay(25);
    signalGroup("SIGKILL");
    if (exit) await exit;
    if (timer) clearTimeout(timer);
    await rm(stateFile, { force: true });
    await rm(join(dir, "ngrok.yml"), { force: true });
    await new Promise<void>((ok) => lock.close(() => ok()));
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    ownerLifetime.off("end", stop);
    ownerLifetime.off("error", stop);
  }
}

export async function connectorRuntime(root: string) {
  const config = await readConfig(root);
  const dir = join(root, ".devos/connector");
  let stopping = false,
    failureReason: string | undefined,
    child: ReturnType<typeof spawn> | undefined,
    gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child?.kill("SIGTERM");
    void gateway?.close().catch(() => {});
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("disconnect", stop);
  try {
    gateway = await startGateway({
      root: softwareRoot,
      port: config.gatewayPort,
      ownerSecret: ownerAuth(process.env.DEVOS_CONNECTOR_OWNER_SECRET),
      oauthClientsPath: join(root, ".devos/connector/oauth-clients.json"),
      oauthStatePath: join(root, ".devos/connector/oauth-state.enc"),
      onFailure: (reason) => {
        failureReason = reason;
        stop();
      },
    });
    if (stopping) {
      if (failureReason) throw new Error(failureReason);
      return;
    }
    await writeFile(
      join(dir, "ngrok.yml"),
      `version: "2"\nweb_addr: 127.0.0.1:${config.ngrokApiPort}\nconsole_ui: false\nupdate_check: false\n`,
      { mode: 0o600 },
    );
    // Only the ngrok process receives its account credential. No request inspector.
    child = spawn(
      join(root, ".devos/tools/ngrok"),
      ngrokArgs(root, config.gatewayPort),
      {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...safeEnvironment(process.env),
          NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
        },
      },
    );
    let ngrokStderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (ngrokStderr.length < 8192)
        ngrokStderr += chunk.slice(0, 8192 - ngrokStderr.length);
    });
    let exited = false;
    const exit = new Promise<void>((ok) => {
      child!.once("error", () => {
        failureReason = "ngrok process failed to start.";
        exited = true;
        ok();
      });
      child!.once("exit", () => {
        if (!stopping) failureReason = ngrokFailureReason(ngrokStderr);
        exited = true;
        ok();
      });
    });
    const deadline = Date.now() + 25_000;
    let url: string | undefined;
    while (!stopping && !exited && Date.now() < deadline) {
      url = await publicEndpoint(config.ngrokApiPort, config.gatewayPort);
      if (url) break;
      await delay(100);
    }
    if (!url || stopping || exited)
      throw new Error(
        failureReason ??
          (exited
            ? "ngrok exited during connector startup."
            : "ngrok tunnel registration timed out."),
      );
    gateway.setPublicUrl(url);
    process.send?.({ publicUrl: url });
    await exit;
    if (failureReason) throw new Error(failureReason);
    if (!stopping) throw new Error("ngrok exited unexpectedly.");
  } finally {
    stop();
    await gateway?.close();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("disconnect", stop);
  }
}
