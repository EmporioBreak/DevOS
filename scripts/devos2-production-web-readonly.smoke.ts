/**
 * Explicit opt-in Production Camoufox Web navigation check (#151).
 * No worker turns, no composer writes, no password/OAuth calls, no chat URLs
 * or page content are printed. Browser's normal persistent-profile engine can
 * update ordinary browser storage; do NOT describe as byte-for-byte read-only.
 */
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {ChatGptBrowserExecutor} from '../src/chatgpt-browser-executor.js';
import {assertChatGptProjectScope,getChatGptProjectScope} from '../src/browser-config.js';
import {camoufoxIdentityPath} from '../src/camoufox-identity.js';
import {profileProcesses} from '../src/owned-browser-process.js';
import type {BrowserContext} from 'playwright-core';

export interface WebNavigationSnapshot {
  http:number|null;
  chatGptHttps:boolean;
  projectScope:boolean;
  loginRedirect:boolean;
  challenge:boolean;
  editorVisible:boolean;
  fingerprintUnchanged:boolean;
  browserCleanupConfirmed:boolean;
}

export function assessProductionWeb(snapshot:WebNavigationSnapshot){
  const status=!snapshot.browserCleanupConfirmed||!snapshot.fingerprintUnchanged
    ?'blocked_cleanup_or_identity'
    :snapshot.loginRedirect?'blocked_login_required'
    :!snapshot.chatGptHttps||snapshot.http!==200||snapshot.challenge
    ?'blocked_navigation_or_challenge'
    :!snapshot.projectScope?'blocked_project_scope'
    :!snapshot.editorVisible?'blocked_composer'
    :'web_navigation_pass';
  return {status,scope:'production_web_project_navigation_only',
    checks:snapshot,chatMessageSent:false,workerStarted:false,
    ownerAuthorizationRequested:false,stagingStarted:false,
    fullProductAcceptance:false,independentlyVerifiedE2e:[] as string[]};
}

const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export async function runProductionWebReadOnly(root:string){
  const projectRoot=join(root,'.devos');
  const config=JSON.parse(await readFile(join(projectRoot,'config.json'),'utf8')) as {
    chatgptProjectUrl?:unknown;
  };
  const target=config.chatgptProjectUrl;
  if(typeof target!=='string'||!getChatGptProjectScope(target))
    throw new Error('project_not_configured');
  const profileDir=join(homedir(),'.devos','camoufox-profile');
  const identityPath=camoufoxIdentityPath(profileDir);
  if(!(await stat(identityPath)).isFile()) throw new Error('identity_file_missing');
  if((await profileProcesses(profileDir)).length!==0)
    throw new Error('profile_in_use_refusing_concurrent_launch');
  const identityBefore=sha(await readFile(identityPath));
  const executor=new ChatGptBrowserExecutor({projectUrl:target,profileDir,headless:false},30_000);
  let page:Awaited<ReturnType<BrowserContext['newPage']>>|undefined;
  const snapshot:WebNavigationSnapshot={
    http:null,chatGptHttps:false,projectScope:false,loginRedirect:false,
    challenge:false,editorVisible:false,fingerprintUnchanged:false,
    browserCleanupConfirmed:false,
  };
  try{
    // Introspection only. Do not call executor.run(): that would submit a turn.
    const ctx=await (executor as unknown as {
      getContext(timeout:number,needsStream:boolean):Promise<BrowserContext>;
    }).getContext(25_000,false);
    page=await ctx.newPage();
    const response=await page.goto(target,{waitUntil:'domcontentloaded',timeout:30_000});
    await page.waitForTimeout(1_400);
    const finalUrl=page.url();
    snapshot.http=response?.status()??null;
    snapshot.chatGptHttps=finalUrl.startsWith('https://chatgpt.com/');
    const pathname=new URL(finalUrl).pathname;
    snapshot.loginRedirect=/\/auth\/(?:login|signup)|\/login|\/signup/i.test(pathname);
    try{assertChatGptProjectScope(target,finalUrl);snapshot.projectScope=true;}catch{}
    const preview=(await page.locator('body').innerText({timeout:4_000}).catch(()=>''))
      .slice(0,500);
    snapshot.challenge=/checking your browser|just a moment|cloudflare challenge/i.test(preview);
    snapshot.editorVisible=(await page.locator(
      '[data-testid="prompt-textarea"]:visible, #prompt-textarea:visible, textarea[placeholder*="Message"]:visible, [contenteditable="true"]:visible',
    ).count())>0;
  }finally{
    await page?.close().catch(()=>{});
    try{await executor.close();}catch{}
    snapshot.fingerprintUnchanged=identityBefore===sha(await readFile(identityPath));
    snapshot.browserCleanupConfirmed=(await profileProcesses(profileDir)).length===0;
  }
  return assessProductionWeb(snapshot);
}

if(process.argv[1]?.endsWith('devos2-production-web-readonly.smoke.ts')){
  if(process.argv.length!==2){
    console.error('Usage: tsx scripts/devos2-production-web-readonly.smoke.ts (run from Production checkout)');
    process.exitCode=2;
  }else{
    runProductionWebReadOnly(process.cwd()).then(report=>{
      console.log(JSON.stringify(report));
      if(report.status!=='web_navigation_pass')process.exitCode=2;
    }).catch(error=>{
      // No error strings, browser URLs, cookies, identity details or stack traces.
      const code=String(error instanceof Error?error.message:error);
      const reason=code==='profile_in_use_refusing_concurrent_launch'?'profile_in_use':
        code==='project_not_configured'?'project_scope':
        code==='identity_file_missing'?'identity_missing':
        /timeout|timed out/i.test(code)?'timeout':
        /browser|launch|firefox/i.test(code)?'browser_launch':'navigation_unknown';
      console.log(JSON.stringify({status:'blocked',reason,
        scope:'production_web_project_navigation_only',
        fullProductAcceptance:false,independentlyVerifiedE2e:[],
        chatMessageSent:false,workerStarted:false,stagingStarted:false}));
      process.exitCode=2;
    });
  }
}
