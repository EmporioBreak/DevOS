import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { parseCliArgs } from '../src/cli.js';
import { connectorConfig, desktopCommand, installPlan, tunnelArgs, TUNNEL_VERSION } from '../src/connector.js';

test('connector CLI accepts only explicit commands and tunnel-id', () => {
  for (const action of ['setup','doctor','run','status']) {
    assert.deepEqual(parseCliArgs(['connector', action]), {kind:'connector', action});
  }
  assert.deepEqual(parseCliArgs(['connector','run','--tunnel-id','tunnel_'+'a'.repeat(32)]), {kind:'connector',action:'run',tunnelId:'tunnel_'+'a'.repeat(32)});
  for (const args of [['connector'],['connector','stop'],['connector','run','--api-key','secret']]) assert.throws(() => parseCliArgs(args), /Usage/);
});
test('config rejects secrets and invalid IDs without reflecting their values', () => {
  const secret = 'super-private-key';
  assert.throws(() => connectorConfig(undefined, {}, {apiKey:secret}), e => !String(e).includes(secret));
  assert.throws(() => connectorConfig(secret, {}, {}), e => !String(e).includes(secret));
  assert.throws(() => connectorConfig(undefined, {}, {}), /tunnel ID/);
  assert.equal(connectorConfig('tunnel_'+'b'.repeat(32), {}, {}).tunnelId, 'tunnel_'+'b'.repeat(32));
});
test('exact local child command and pinned project-local Go installation', () => {
  const root = '/project with spaces';
  const command = desktopCommand(root);
  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, [root+'/node_modules/@wonderwhy-er/desktop-commander/dist/index.js','--no-onboarding']);
  const plan = installPlan(root);
  assert.deepEqual(plan.args, ['install', '-ldflags=-X github.com/openai/tunnel-client/pkg/version.Flavor=runtime', 'github.com/openai/tunnel-client/cmd/client-runtime@'+TUNNEL_VERSION]);
  assert.equal(plan.env.GOBIN, root+'/.devos/tools');
  assert.equal(plan.env.GOENV, 'off');
});

import { spawn } from 'node:child_process';
import { chmod, realpath, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const cli = fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const loader = fileURLToPath(import.meta.resolve('tsx'));
const id = 'tunnel_'+randomBytes(16).toString('hex');
const secret = 'fake-secret-for-tests-only';
async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'devos connector spaces ')));
  await mkdir(join(root,'.devos/tools'),{recursive:true});
  const binary=join(root,'.devos/tools/tunnel-client');
  await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs');
const http=require('node:http');
const cp=require('node:child_process');
if(process.argv.includes('--version')) {console.log('oai-tunnel-client 0.0.15');process.exit(0);}
fs.writeFileSync('observed.json',JSON.stringify({args:process.argv.slice(2),keyPresent:!!process.env.CONTROL_PLANE_API_KEY,debug:process.env.LOG_HTTP_RAW_UNSAFE}));
// Deliberately echo a split secret: wrapper must never forward child output.
process.stdout.write(process.env.CONTROL_PLANE_API_KEY.slice(0,4));
setTimeout(()=>process.stderr.write(process.env.CONTROL_PLANE_API_KEY.slice(4)),10);
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync('child.pid',String(child.pid));
const server=http.createServer((req,res)=>{res.end('ready');});
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[process.argv.indexOf('--health.url-file')+1],'http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>process.exit(0));
`);
  await chmod(binary,0o755);
  return root;
}
function start(root: string, args: string[], key: string|undefined=secret) {
  const env: NodeJS.ProcessEnv={...process.env,CONTROL_PLANE_TUNNEL_ID:id,LOG_HTTP_RAW_UNSAFE:'true'};
  delete env.CONTROL_PLANE_API_KEY;
  delete env.OPENAI_API_KEY;
  if(key) env.CONTROL_PLANE_API_KEY=key;
  const child=spawn(process.execPath,['--import',loader,cli,'connector',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';
  child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  const done=new Promise<{code:number|null;output:string}>(ok=>child.once('close',code=>ok({code,output})));
  return {child,done,output:()=>output};
}
async function waitReady(proc: ReturnType<typeof start>) {
  const deadline=Date.now()+8000;
  while(!proc.output().includes('Connector ready:') && Date.now()<deadline) await delay(50);
  assert.match(proc.output(),/Connector ready:/);
}
test('dispatch, env-only secrets, foreground status, machine-wide duplicates and SIGINT/SIGTERM cleanup',async()=>{
  for(const signal of ['SIGINT','SIGTERM'] as const) {
    const root=await fixture();const other=await fixture();
    const proc=start(root,['run']);
    try {
      await waitReady(proc);
      const observed=JSON.parse(await readFile(join(root,'observed.json'),'utf8'));
      assert.equal(observed.keyPresent,true);assert.equal(observed.debug,undefined);
      assert.ok(!JSON.stringify(observed.args).includes(secret));
      assert.match(observed.args.join(' '),/connector-desktop\.js/);
      assert.equal((await start(root,['status']).done).output.includes('Connector ready:'),true);
      const duplicate=await start(other,['run']).done;
      assert.equal(duplicate.code,1);assert.match(duplicate.output,/Duplicate active connector/);
      proc.child.kill(signal);
      const result=await proc.done;
      assert.equal(result.code,0);assert.ok(!result.output.includes(secret));
      const childPid=Number(await readFile(join(root,'child.pid'),'utf8'));
      await delay(100);
      assert.throws(()=>process.kill(childPid,0));
      assert.match((await start(root,['status']).done).output,/stopped/);
    } finally {proc.child.kill('SIGTERM');await proc.done;await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
  }
});
test('missing key, malformed config and stale version fail without exposing secret',async()=>{
  const root=await fixture();
  try {
    const missing=await start(root,['run'],'').done;
    assert.match(missing.output,/Missing runtime key/);assert.equal(missing.code,1);
    await mkdir(join(root,'.devos/connector'),{recursive:true});
    await writeFile(join(root,'.devos/connector/config.json'),JSON.stringify({apiKey:secret}));
    const invalid=await start(root,['doctor']).done;
    assert.equal(invalid.code,1);assert.ok(!invalid.output.includes(secret));
    await rm(join(root,'.devos/connector/config.json'));
    await writeFile(join(root,'.devos/tools/tunnel-client'),`#!${process.execPath}\nconsole.log('0.0.14');`);
    const stale=await start(root,['doctor']).done;
    assert.match(stale.output,/Missing\/stale tunnel-client/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('setup installs pinned module into project paths without credentials or global Go changes',async()=>{
  const root=await fixture();
  try {
    await rm(join(root,'.devos/tools/tunnel-client'));
    const bin=join(root,'bin');await mkdir(bin);
    await writeFile(join(bin,'go'),`#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
fs.writeFileSync('install.json',JSON.stringify({args:process.argv.slice(2),env:process.env}));
fs.writeFileSync(path.join(process.env.GOBIN,'client-runtime'),${JSON.stringify('#!'+process.execPath+'\nconsole.log("oai-tunnel-client 0.0.15");')});
fs.chmodSync(path.join(process.env.GOBIN,'client-runtime'),0o755);
`);await chmod(join(bin,'go'),0o755);
    const prev=process.env.PATH;process.env.PATH=bin+':'+prev;
    let result;
    try {result=await start(root,['setup'],'').done;}finally{process.env.PATH=prev;}
    assert.equal(result.code,0,result.output);
    const observed=JSON.parse(await readFile(join(root,'install.json'),'utf8'));
    assert.deepEqual(observed.args,installPlan(root).args);
    assert.equal(observed.env.GOENV,'off');assert.equal(observed.env.GOBIN,join(root,'.devos/tools'));
    assert.equal(observed.env.CONTROL_PLANE_API_KEY,undefined);
    assert.equal((await start(root,['setup'],'').done).code,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('stdio bridge strips runtime/admin keys and debug environment from Desktop Commander',async()=>{
  const root=await mkdtemp(join(tmpdir(),'devos bridge '));
  try{
    const dist=join(root,'node_modules/@wonderwhy-er/desktop-commander/dist');await mkdir(dist,{recursive:true});
    await writeFile(join(dist,'index.js'),`console.log(JSON.stringify({env:process.env,args:process.argv.slice(2)}));`);
    const bridge=fileURLToPath(new URL('../src/connector-desktop.ts',import.meta.url));
    const child=spawn(process.execPath,['--import',loader,bridge,root],{env:{...process.env,CONTROL_PLANE_API_KEY:secret,OPENAI_API_KEY:secret,OPENAI_ADMIN_KEY:secret,DEVOS_DEBUG:'1'},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
    const code=await new Promise(ok=>child.once('close',ok));
    assert.equal(code,0);assert.ok(!output.includes(secret));
    const observed=JSON.parse(output);assert.deepEqual(observed.args,['--no-onboarding']);
    assert.equal(observed.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY,'1');assert.equal(observed.env.DEVOS_DEBUG,undefined);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('unhealthy early startup fails and releases instance guard',async()=>{
  const root=await fixture();
  try {
    await writeFile(join(root,'.devos/tools/tunnel-client'),`#!${process.execPath}\nif(process.argv.includes('--version')) console.log('0.0.15');else {console.error(process.env.CONTROL_PLANE_API_KEY);process.exit(7);}`);
    for(let n=0;n<2;n++) {
      const result=await start(root,['run']).done;
      assert.equal(result.code,1);assert.match(result.output,/startup unhealthy/);assert.ok(!result.output.includes(secret));
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('real runtime logging configuration always pairs level with format',()=>{
  const args=tunnelArgs('/root',id,'/root/.devos/health');
  assert.equal(args[args.indexOf('--log.format')+1],'json');
});

async function cleanupFixture(root: string, grace: boolean) {
  const runtime=join(root,'.devos/tools/tunnel-client');
  await writeFile(runtime,`#!${process.execPath}
const fs=require('node:fs'),http=require('node:http'),cp=require('node:child_process');
if(process.argv.includes('--version')){console.log('0.0.15');process.exit(0);}
fs.writeFileSync('runtime.pid',String(process.pid));
const script=${JSON.stringify("const fs=require('node:fs');process.on('SIGTERM',()=>{if(process.argv[1]==='grace'&&!global.stopping){global.stopping=true;setTimeout(()=>{fs.writeFileSync('cleanup.done','done');process.exit(0)},750)}});fs.writeFileSync('cleanup.armed','yes');setInterval(()=>{},1000);")};
const descendant=cp.spawn(process.execPath,['-e',script,${JSON.stringify(grace?'grace':'ignore')}],{stdio:'ignore'});
fs.writeFileSync('child.pid',String(descendant.pid));
const server=http.createServer((req,res)=>res.end('ready'));
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[process.argv.indexOf('--health.url-file')+1],'http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>process.exit(0));
`);
}
async function waitFile(file: string) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) {try{return await readFile(file,'utf8');}catch{await delay(25);}}
  throw new Error('Expected fixture file was not created');
}
function alive(pid: number) {try{process.kill(pid,0);return true;}catch{return false;}}
test('fast tunnel parent exit preserves descendant SIGTERM cleanup grace',async()=>{
  const root=await fixture();await cleanupFixture(root,true);
  const proc=start(root,['run']);let runtimePid=0;
  try {
    await waitReady(proc);await waitFile(join(root,'cleanup.armed'));
    runtimePid=Number(await readFile(join(root,'runtime.pid'),'utf8'));
    proc.child.kill('SIGTERM');assert.equal((await proc.done).code,0);
    assert.equal(await readFile(join(root,'cleanup.done'),'utf8'),'done');
    assert.equal(alive(Number(await readFile(join(root,'child.pid'),'utf8'))),false);
  }finally{proc.child.kill('SIGTERM');if(runtimePid)try{process.kill(-runtimePid,'SIGKILL');}catch{}await proc.done;await rm(root,{recursive:true,force:true});}
});
test('abrupt CLI death cannot launch a second runtime while the first group survives',async()=>{
  const root=await fixture(),other=await fixture();await cleanupFixture(root,false);
  const first=start(root,['run']);let second: ReturnType<typeof start>|undefined;let oldPid=0;
  try {
    await waitReady(first);await waitFile(join(root,'cleanup.armed'));
    oldPid=Number(await readFile(join(root,'runtime.pid'),'utf8'));
    const descendant=Number(await readFile(join(root,'child.pid'),'utf8'));
    const ownerExited=new Promise(ok=>first.child.once('exit',ok));
    first.child.kill('SIGKILL');await ownerExited;
    second=start(other,['run']);
    const deadline=Date.now()+5000;
    while(Date.now()<deadline && !second.output().includes('Duplicate') && !second.output().includes('Connector ready:')) await delay(25);
    assert.match(second.output(),/Duplicate active connector/);
    assert.equal((await second.done).code,1);
    const cleaned=Date.now()+5000;while((alive(oldPid)||alive(descendant))&&Date.now()<cleaned) await delay(25);
    assert.equal(alive(oldPid),false);assert.equal(alive(descendant),false);
    assert.match((await start(root,['status']).done).output,/stopped/);
    const next=start(other,['run']);second=next;await waitReady(next);next.child.kill('SIGTERM');assert.equal((await next.done).code,0);
  }finally{first.child.kill('SIGTERM');second?.child.kill('SIGTERM');if(oldPid)try{process.kill(-oldPid,'SIGKILL');}catch{}await first.done;if(second)await second.done;await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
});

test('unresponsive runtime parent is forcibly terminated within bounded shutdown',async()=>{
  const root=await fixture();await cleanupFixture(root,false);
  const binary=join(root,'.devos/tools/tunnel-client');
  await writeFile(binary,(await readFile(binary,'utf8')).replace("process.on('SIGTERM',()=>process.exit(0));","process.on('SIGTERM',()=>{});"));
  const proc=start(root,['run']);let pid=0;
  try {
    await waitReady(proc);await waitFile(join(root,'cleanup.armed'));
    pid=Number(await readFile(join(root,'runtime.pid'),'utf8'));
    proc.child.kill('SIGTERM');
    const result=await Promise.race([proc.done,delay(5000,undefined,{ref:false}).then(()=>null)]);
    assert.ok(result,'shutdown exceeded its bounded grace');assert.equal(result.code,0);
    assert.equal(alive(pid),false);
  }finally{if(pid)try{process.kill(-pid,'SIGKILL');}catch{}proc.child.kill('SIGTERM');await proc.done;await rm(root,{recursive:true,force:true});}
});
