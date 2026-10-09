import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { NGROK_VERSION } from "../src/connector.js";
export const fixtureSecret =
  "synthetic-ngrok-owner-credential-for-local-tests-only";
const secret = fixtureSecret;
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
async function freePort() {
  const server = createServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((ok) => server.close(() => ok()));
  return port;
}
export async function fixture(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "devos ngrok "));
  await mkdir(join(root, ".devos/tools"), { recursive: true });
  await mkdir(join(root, ".devos/connector"), { recursive: true });
  const gatewayPort = await freePort(),
    ngrokApiPort = await freePort();
  await writeFile(
    join(root, ".devos/connector/config.json"),
    JSON.stringify({ version: 1, gatewayPort, ngrokApiPort }),
  );
  const version = NGROK_VERSION;
  const binary = join(root, ".devos/tools/ngrok");
  const script = `#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process');
if(process.argv.includes('version')) {console.log('ngrok version ${version}');process.exit(0);}
const config=fs.readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8');
fs.writeFileSync('observed.json',JSON.stringify({pid:process.pid,args:process.argv.slice(2),config,keyPresent:!!process.env.NGROK_AUTHTOKEN,ownerPresent:!!process.env.DEVOS_CONNECTOR_OWNER_SECRET,debug:process.env.DEVOS_DEBUG}));
process.stdout.write((process.env.NGROK_AUTHTOKEN||'').slice(0,8));setTimeout(()=>process.stderr.write((process.env.NGROK_AUTHTOKEN||'').slice(8)),10);
if(${JSON.stringify(mode)}==='fail'){process.exit(2);}
const child=cp.spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync('cleanup.marker','done');process.exit(0);},750));fs.writeFileSync('child.armed','yes');setInterval(()=>{},1000);")}],{stdio:'ignore'});
fs.writeFileSync('child.pid',String(child.pid));
if(${JSON.stringify(mode)}==='stubborn'){process.on('SIGTERM',()=>{});}else{process.on('SIGTERM',()=>process.exit(0));}
if(${JSON.stringify(mode)}!=='slow')http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tunnels:[{public_url:'https://controlled.ngrok.example',config:{addr:process.argv[3]}}]}));}).listen(${ngrokApiPort},'127.0.0.1');
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  await writeFile(
    binary + ".json",
    JSON.stringify({
      version,
      sha256: createHash("sha256").update(script).digest("hex"),
    }),
  );
  return { root, gatewayPort, ngrokApiPort, binary };
}
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const loader = fileURLToPath(import.meta.resolve("tsx"));
export function start(
  root: string,
  action: string,
  overrides: NodeJS.ProcessEnv = {},
) {
  const child = spawn(
    process.execPath,
    ["--import", loader, cli, "connector", action],
    {
      cwd: root,
      env: {
        ...process.env,
        NGROK_AUTHTOKEN: secret,
        DEVOS_CONNECTOR_OWNER_SECRET: secret,
        DEVOS_DEBUG: "1",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (s) => (output += s));
  child.stderr.on("data", (s) => (output += s));
  const done = new Promise<{ code: number | null; output: string }>((ok) =>
    child.once("close", (code) => ok({ code, output })),
  );
  return { child, done, output: () => output };
}
// Same real foreground connector and runtime as start(..., "run"), but with
// only the supervisor's backoff clock injected. The process isolation keeps
// exit status, stderr redaction and env handling under test as before.
export function startWithImmediateRetryClock(root: string) {
  const connectorUrl = new URL("../src/connector.ts", import.meta.url).href;
  const script = [
    'import { PassThrough } from "node:stream";',
    `import { connector } from ${JSON.stringify(connectorUrl)};`,
    "const delays = [];",
    "const lifetime = new PassThrough();",
    "try {",
    '  await connector("run", process.cwd(), lifetime, { sleep: async ms => { delays.push(ms); } });',
    "} catch (error) {",
    "  console.error(error instanceof Error ? error.message : String(error));",
    "  process.exitCode = 1;",
    "} finally {",
    "  lifetime.destroy();",
    '  console.log("DEVOS_TEST_RETRY_DELAYS=" + JSON.stringify(delays));',
    "}",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--import", loader, "--input-type=module", "--eval", script],
    {
      cwd: root,
      env: {
        ...process.env,
        NGROK_AUTHTOKEN: secret,
        DEVOS_CONNECTOR_OWNER_SECRET: secret,
        DEVOS_DEBUG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  const done = new Promise<{ code: number | null; output: string }>((resolve) =>
    child.once("close", (code) => resolve({ code, output })),
  );
  return { child, done, output: () => output };
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Condition timed out");
}
export async function ready(proc: ReturnType<typeof start>) {
  await waitFor(() => proc.output().includes("Connector ready:"));
}
export function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export function directDesktopCommanderChild(runtimePid: number): number | undefined {
  const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  for (const line of processes.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (
      match &&
      Number(match[2]) === runtimePid &&
      match[3]!.includes("/node_modules/@wonderwhy-er/desktop-commander/dist/index.js")
    ) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export function processIsStopped(pid: number): boolean {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    })
      .trim()
      .startsWith("T");
  } catch {
    return false;
  }
}
