// Explicit opt-in smoke: npm run build && npx tsx tests/connector-local.smoke.ts
// Uses the installed pinned binary + actual stdio Desktop Commander, only a
// loopback fake control plane and fake credentials. Never contacts Platform.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { safeEnvironment, tunnelArgs } from '../src/connector.js';
const root=resolve(import.meta.dirname,'..');
const dir=await mkdtemp(join(root,'.devos/connector-smoke-'));
const health=join(dir,'health');
let phase=0;
function command(requestId: string, rpc: unknown) {
  return {request_id:requestId,shard_token:'local-only',command_type:'jsonrpc',channel:'main',created_at:new Date().toISOString(),headers:{'Mcp-Session-Id':['local-smoke-session']},jsonrpc:rpc};
}
let tools: unknown;
let polls=0;
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url?.includes('/poll')) {
    polls++;
    let next: unknown;
    if(phase===0) {phase=1;next=command('smoke-init',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'devos-local-smoke',version:'1'}}});}
    else if(phase===2) {phase=3;next=command('smoke-notify',{jsonrpc:'2.0',method:'notifications/initialized',params:{}});}
    else if(phase===4) {phase=5;next=command('smoke-tools',{jsonrpc:'2.0',id:2,method:'tools/list',params:{}});}
    if(next) res.end(JSON.stringify({commands:[next]}));
    else setTimeout(()=>res.end(JSON.stringify({commands:[]})),100);
  } else if(req.url?.endsWith('/response')) {
    let body='';for await(const chunk of req) body+=chunk;
    const result=JSON.parse(body);
    if(result.request_id==='smoke-init') phase=2;
    if(result.request_id==='smoke-notify') phase=4;
    if(result.request_id==='smoke-tools') tools=result.resp_json;
    res.end('{}');
  } else {res.end('{}');}
});
await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
const port=(server.address() as {port:number}).port;
const args=[...tunnelArgs(root,'tunnel_'+'d'.repeat(32),health,root),'--control-plane.base-url',`http://127.0.0.1:${port}`];
const child=spawn(join(root,'.devos/tools/tunnel-client'),args,{cwd:dir,detached:true,stdio:['ignore','pipe','pipe'],env:{...safeEnvironment(process.env),HOME:dir,CONTROL_PLANE_API_KEY:'local-fake-runtime-key'}});
let diagnostic='';child.stdout!.on('data',chunk=>diagnostic+=chunk);child.stderr!.on('data',chunk=>diagnostic+=chunk);
const exited=new Promise(ok=>child.once('close',ok));
try {
  const deadline=Date.now()+30_000;
  while(!tools && Date.now()<deadline) await delay(100);
  const rpc=tools as {result?:{tools?:{name:string}[]};error?:unknown};
  if (!rpc?.result) throw new Error('Local smoke failed: '+diagnostic.replaceAll('local-fake-runtime-key','[redacted]'));
  assert.ok(rpc?.result?.tools?.some(t=>t.name==='read_file'), 'actual Desktop Commander tool catalog must return read_file');
  const base=(await readFile(health,'utf8')).trim();
  assert.equal((await fetch(new URL('/readyz',base), {signal:AbortSignal.timeout(2000)})).status,200);
  assert.ok(polls>0);
  console.log(`Local tunnel smoke OK: ${rpc.result!.tools!.length} Desktop Commander tools; loopback fake control plane only.`);
} finally {
  try{process.kill(-child.pid!,'SIGTERM');}catch{/* already gone */}
  await Promise.race([exited,delay(3000,undefined,{ref:false})]);
  try{process.kill(-child.pid!,'SIGKILL');}catch{/* already gone */}
  server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));
  await rm(dir,{recursive:true,force:true});
}
