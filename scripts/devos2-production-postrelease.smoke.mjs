/**
 * Owner-run read-only Production baseline probe (#154).
 * No passwords, OAuth state, cookies, user content or browser session URL
 * is read or returned. This does NOT perform browser-worker/iPhone E2E.
 */
import {spawnSync} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';

const EXACT_SHA=/^[a-f0-9]{40}$/;
const OFFLINE_GATE_IDS=["LIVE-GITHUB-LINKS","LIVE-FEATURE-SDD","LIVE-BUGFIX",
  "LIVE-ASSESS","LIVE-BROWSER-CODEX","LIVE-WEB","LIVE-PRODUCTION-ISOLATION",
  "LIVE-CHAOS","LIVE-DOCS"];

export function classifyBaseline(baseline){
  const checks={
    local_health:baseline.localHealth===200,
    public_health:baseline.publicHealth===200,
    local_oauth_discovery:baseline.localOAuth===200,
    public_oauth_discovery:baseline.publicOAuth===200,
    anonymous_local_denied:[401,403].includes(baseline.localAnonymous),
    invalid_local_denied:[401,403].includes(baseline.localInvalid),
    anonymous_public_denied:[401,403].includes(baseline.publicAnonymous),
    invalid_public_denied:[401,403].includes(baseline.publicInvalid),
    git_branch_main:baseline.branch==='main',
    git_checkout_clean:baseline.checkoutClean===true,
    git_remote_synced:EXACT_SHA.test(baseline.head??'') && baseline.head===baseline.remoteHead,
    staging_mcp_off:baseline.stagingPortOccupied===false,
    camoufox_profile_present:baseline.profilePresent===true,
  };
  return {status:Object.values(checks).every(Boolean)?'baseline_pass':'blocked',
    checks,productionSha:EXACT_SHA.test(baseline.head??'')?baseline.head:null,
    scope:'read_only_production_transport_baseline',
    independentlyVerifiedE2e:[],pendingRealE2e:[...OFFLINE_GATE_IDS],
    browserWorkersStarted:false,productionMutated:false,
    fullProductAcceptance:false};
}

function cmd(program,args,timeout=10000){
  const r=spawnSync(program,args,{encoding:'utf8',timeout,maxBuffer:1024*1024});
  if(r.error || r.status!==0) throw new Error(`Read-only check failed: ${program} (exit ${r.status})`);
  return r.stdout.trim();
}
function curlCode(url,method='GET',invalidBearer=false){
  const args=['--noproxy','*','--silent','--show-error','--max-time','8',
    '--output','/dev/null','--write-out','%{http_code}',
    '-X',method];
  if(method==='POST') args.push('-H','Content-Type: application/json',
    '--data-binary','{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
  if(invalidBearer)args.push('-H','Authorization: Bearer devos-invalid-test-token');
  args.push(url);
  const result=Number(cmd('/usr/bin/curl',args,12000));
  if(!Number.isInteger(result)||result<100||result>599)
    throw new Error('Malformed HTTP status from read-only test');
  return result;
}
export function checkedPublicBase(runtime){
  const raw=runtime?.publicUrl;
  if(typeof raw!=='string')throw new Error('Missing Production public URL');
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||
    url.pathname!=='/'||!(/^[a-z0-9-]+\.ngrok-free\.dev$/).test(url.hostname))
    throw new Error('Expected exact Production ngrok HTTPS origin');
  return url.origin;
}
async function verifyProfile(path){
  try{return (await lstat(path)).isDirectory();}catch{return false;}
}
export async function runProductionBaseline(root,profileDir=join(homedir(),'.devos','camoufox-profile')){
  const project=resolve(root);
  const runtime=JSON.parse(await readFile(join(project,'.devos','connector','state.json'),'utf8'));
  const pub=checkedPublicBase(runtime),local='http://127.0.0.1:8787';
  // No request carries a valid bearer token. The only POST is an intentionally
  // denied synthetic initialize, with no secret/session metadata.
  const head=cmd('git',['-C',project,'rev-parse','HEAD']);
  const remote=cmd('git',['-C',project,'ls-remote','origin','refs/heads/main'],30000)
    .split(/\s+/)[0];
  const branch=cmd('git',['-C',project,'branch','--show-current']);
  const checkoutClean=cmd('git',['-C',project,'status','--porcelain']).length===0;
  const port=spawnSync('/usr/sbin/lsof',['-nP','-iTCP:8788','-sTCP:LISTEN'],
    {encoding:'utf8',timeout:4000});
  if(port.error||(port.status!==0&&port.status!==1))
    throw new Error('Could not determine whether retired Staging port is running');
  return classifyBaseline({head,remoteHead:remote,branch,checkoutClean,
    stagingPortOccupied:port.status===0,profilePresent:await verifyProfile(profileDir),
    localHealth:curlCode(local+'/health'),publicHealth:curlCode(pub+'/health'),
    localOAuth:curlCode(local+'/.well-known/oauth-authorization-server'),
    publicOAuth:curlCode(pub+'/.well-known/oauth-authorization-server'),
    localAnonymous:curlCode(local+'/mcp','POST'),
    localInvalid:curlCode(local+'/mcp','POST',true),
    publicAnonymous:curlCode(pub+'/mcp','POST'),
    publicInvalid:curlCode(pub+'/mcp','POST',true)});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==2){
    console.error('Usage: node scripts/devos2-production-postrelease.smoke.mjs (run in Production checkout)');
    process.exitCode=2;
  }else{
    runProductionBaseline(process.cwd())
      .then(r=>{console.log(JSON.stringify(r));if(r.status!=='baseline_pass')process.exitCode=2;})
      .catch(e=>{console.error('Post-release baseline blocked: '+e.message);process.exitCode=2;});
  }
}
