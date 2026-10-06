import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const TUNNEL_VERSION = 'v0.0.15';
export const DESKTOP_VERSION = '0.2.52';
export type ConnectorAction = 'setup' | 'doctor' | 'run' | 'status';
const moduleDir = dirname(fileURLToPath(import.meta.url));
const softwareRoot = resolve(moduleDir, existsSync(join(moduleDir,'../package.json')) ? '..' : '../..');
const idPattern = /^tunnel_[a-f0-9]{32}$/;

export function connectorConfig(id: string | undefined, env: NodeJS.ProcessEnv, config: unknown): { tunnelId: string } {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => !['version','tunnelId'].includes(k)) || ('version' in config && config.version !== 1)) {
    throw new Error('Invalid connector config: only version: 1 and tunnelId are allowed; runtime key must stay env-only.');
  }
  const value = id ?? env.CONTROL_PLANE_TUNNEL_ID ?? (config as {tunnelId?: unknown}).tunnelId;
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('Missing or invalid tunnel ID: use --tunnel-id tunnel_<32 lowercase hex>, CONTROL_PLANE_TUNNEL_ID or .devos/connector/config.json.');
  return { tunnelId: value };
}

export function desktopCommand(root: string) {
  return { file: process.execPath, args: [join(root, 'node_modules/@wonderwhy-er/desktop-commander/dist/index.js'), '--no-onboarding'] };
}

// Do not propagate user profiles, debug switches or credentials into installers.
export function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH','HOME','TMPDIR','SystemRoot','LANG']) if (env[k]) out[k] = env[k];
  return out;
}
export function installPlan(root: string) {
  return {
    args: ['install', '-ldflags=-X github.com/openai/tunnel-client/pkg/version.Flavor=runtime', `github.com/openai/tunnel-client/cmd/client-runtime@${TUNNEL_VERSION}`],
    env: { ...safeEnvironment(process.env), GOBIN: join(root,'.devos/tools'), GOPATH: join(root,'.devos/go'), GOCACHE: join(root,'.devos/go-build'), GOENV: 'off', GOTOOLCHAIN: 'auto' },
  };
}

async function checkedVersion(binary: string): Promise<void> {
  const result = spawnSync(binary, ['--version'], {env:safeEnvironment(process.env), encoding:'utf8', timeout:10_000, maxBuffer:64*1024});
  if (result.status !== 0 || !/(?:^|\s)0\.0\.15(?:\+[a-zA-Z0-9.-]+)?(?:\s|$)/.test(result.stdout)) throw new Error(`Missing/stale tunnel-client; run ./devos connector setup (requires ${TUNNEL_VERSION}).`);
}
async function checkDesktop(root: string) {
  try {
    const pkg = JSON.parse(await readFile(join(root,'node_modules/@wonderwhy-er/desktop-commander/package.json'),'utf8'));
    if (pkg.version !== DESKTOP_VERSION) throw new Error();
    await access(desktopCommand(root).args[0]!);
  } catch { throw new Error(`Missing/stale Desktop Commander ${DESKTOP_VERSION}; run ./devos connector setup.`); }
}

async function readConfig(root: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(root,'.devos/connector/config.json'),'utf8')); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('Invalid .devos/connector/config.json; use only version: 1 and tunnelId.');
  }
}

function quote(value: string): string { return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'; }
export function tunnelArgs(root: string, id: string, healthFile: string, serverRoot = softwareRoot) {
  // Upstream uses shellwords parsing (no shell execution). The bridge clears secrets
  // before launching the exact local Desktop Commander stdio entrypoint.
  const command = [process.execPath, join(serverRoot,'dist/src/connector-desktop.js'), serverRoot].map(quote).join(' ');
  return ['run', '--control-plane.tunnel-id', id, '--mcp.command', command,
    '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile,
    '--log.level', 'warn', '--log.format', 'json', '--log.http-raw-unsafe=false'];
}

// A loopback socket is the machine-wide mutex, also across project checkouts.
// Hash collisions fail closed. No global files/config or background services.
export function lockPort(id: string): number { return 20000 + createHash('sha256').update(id).digest().readUInt32BE(0) % 40000; }
async function acquire(id: string) {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((ok, fail) => {
    server.once('error', () => fail(new Error('Duplicate active connector (or occupied lock port); stop the existing foreground connector before retrying.')));
    server.listen({host:'127.0.0.1',port:lockPort(id),exclusive:true}, ok);
  });
  return server;
}
async function readiness(file: string): Promise<boolean> {
  try {
    const base = (await readFile(file,'utf8')).trim();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(base)) return false;
    return (await fetch(new URL('/readyz',base), {signal:AbortSignal.timeout(1000),redirect:'error'})).ok;
  } catch { return false; }
}

export async function connector(action: ConnectorAction, root: string, id?: string): Promise<void> {
  const tools = join(root,'.devos/tools');
  const binary = join(tools,'tunnel-client');
  const dir = join(root,'.devos/connector');
  if (action === 'setup') {
    if (id !== undefined) connectorConfig(id,{},{});
    await mkdir(tools,{recursive:true});
    // The package lock belongs to the software checkout/runtime, not the target product.
    try { await checkDesktop(softwareRoot); } catch {
      const npm = spawnSync('npm',['ci','--ignore-scripts'], {cwd:softwareRoot,env:safeEnvironment(process.env),stdio:'ignore'});
      if (npm.status !== 0) throw new Error('Desktop Commander dependency install failed; run npm ci in the DevOS software directory.');
      await checkDesktop(softwareRoot);
    }
    try { await checkedVersion(binary); } catch {
      const plan = installPlan(root);
      process.stdout.write(`Building official tunnel runtime ${TUNNEL_VERSION} locally (Go toolchain auto-download may be needed)…\n`);
      const go = spawn('go',plan.args,{env:plan.env,stdio:'ignore'});
      const code = await new Promise<number|null>(ok => { go.once('error',()=>ok(-1)); go.once('exit',ok); });
      if (code !== 0) throw new Error('Pinned Go install failed; check Go, network and toolchain auto-download support, then retry connector setup.');
      await checkedVersion(join(tools,'client-runtime'));
      await rename(join(tools,'client-runtime'),binary);
    }
    await mkdir(dir,{recursive:true});
    if (id !== undefined) {
      const config = connectorConfig(id,{},{});
      await writeFile(join(dir,'config.json'),JSON.stringify({version:1,...config},null,2)+'\n',{mode:0o600});
    }
    process.stdout.write(`Connector software ready: Desktop Commander ${DESKTOP_VERSION}, tunnel-client ${TUNNEL_VERSION}.\n`);
    return;
  }
  const config = connectorConfig(id,process.env,await readConfig(root));
  const stateFile = join(dir,`${config.tunnelId}.json`);
  if (action === 'status') {
    let state: {pid?: number; healthFile?: string} = {};
    try { state = JSON.parse(await readFile(stateFile,'utf8')); } catch { /* no active state */ }
    let alive = false;
    if (Number.isSafeInteger(state.pid) && state.pid! > 0) { try { process.kill(state.pid!,0); alive=true; } catch { /* stopped */ } }
    const expected = join(dir,`${config.tunnelId}.health`);
    const ready = alive && state.healthFile === expected && await readiness(expected);
    process.stdout.write(`Connector ${alive ? ready ? 'ready' : 'running (not ready)' : 'stopped'}: ${config.tunnelId}\n`);
    return;
  }
  await checkDesktop(softwareRoot);
  await checkedVersion(binary);
  if (action === 'doctor') {
    const lock = await acquire(config.tunnelId);
    await new Promise<void>(ok=>lock.close(()=>ok()));
    process.stdout.write(`Local software/config OK. Runtime key ${process.env.CONTROL_PLANE_API_KEY?.trim() ? 'present' : 'missing: set CONTROL_PLANE_API_KEY before run'}. Platform connectivity was not tested.\n`);
    return;
  }
  if (!process.env.CONTROL_PLANE_API_KEY?.trim()) throw new Error('Missing runtime key: set CONTROL_PLANE_API_KEY in the environment before connector run.');
  const lock = await acquire(config.tunnelId);
  const healthFile = join(dir,`${config.tunnelId}.health`);
  let child: ReturnType<typeof spawn> | undefined;
  let exit: Promise<number|null> | undefined;
  let stopping = false;
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (signal: NodeJS.Signals) => { if(child?.pid) { try { process.kill(-child.pid,signal); } catch { /* already gone */ } } };
  const stop = () => { stopping=true; killGroup('SIGTERM'); if (!killTimer) killTimer=setTimeout(()=>killGroup('SIGKILL'),3000); };
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
  try {
    await mkdir(dir,{recursive:true});
    await rm(healthFile,{force:true});
    if (stopping) return;
    child = spawn(binary,tunnelArgs(root,config.tunnelId,healthFile), {
      cwd:root, detached:true, stdio:['ignore','ignore','ignore'],
      env:{...safeEnvironment(process.env),CONTROL_PLANE_API_KEY:process.env.CONTROL_PLANE_API_KEY},
    });
    // Upstream/child output is deliberately not forwarded: arbitrary error output
    // can contain secrets, including split chunks. DevOS emits fixed diagnostics.
    let exited = false;
    exit = new Promise<number|null>(ok => {
      child!.once('error',()=>{exited=true;ok(-1);});
      child!.once('exit',code=>{exited=true;ok(code);});
    });
    await writeFile(stateFile,JSON.stringify({pid:child.pid,healthFile})+'\n',{mode:0o600});
    const deadline = Date.now()+30_000;
    let ready = false;
    while (!exited && !stopping && Date.now()<deadline) {
      if (await readiness(healthFile)) {ready=true;break;}
      await delay(100);
    }
    if (!ready && !stopping) throw new Error('Connector startup unhealthy: check tunnel ID/runtime key permissions (Tunnels Read + Use), outbound HTTPS and local MCP dependencies.');
    if (ready && !stopping) process.stdout.write(`Connector ready: ${config.tunnelId}. Foreground; Ctrl+C stops tunnel and Desktop Commander.\n`);
    const code = await exit;
    if (!stopping) throw new Error(`Connector exited unexpectedly (${code ?? 'signal'}); check runtime credentials and local MCP dependencies.`);
  } finally {
    stop();
    // Also remove any surviving MCP descendants after a tunnel exit.
    if (exit) await Promise.race([exit, delay(3000, undefined, {ref:false})]);
    killGroup('SIGKILL');
    if (killTimer) clearTimeout(killTimer);
    await rm(stateFile,{force:true}); await rm(healthFile,{force:true});
    await new Promise<void>(ok=>lock.close(()=>ok()));
    process.off('SIGINT',stop); process.off('SIGTERM',stop);
  }
}
