import assert from "node:assert/strict";
import test from "node:test";
import {chatGptBrowserDeps} from "../src/chatgpt-browser-executor.js";
import {STAGING_QA_HEADLESS,launchVisibleStagingCamoufox} from "./staging-headed-launch.js";
import {readFile} from "node:fs/promises";

test("staging QA uses DevOS v1 persistent headed launch and saved fingerprint",async()=>{
 assert.equal(STAGING_QA_HEADLESS,false);
 const originalLoad=chatGptBrowserDeps.loadIdentity;
 const originalLaunch=chatGptBrowserDeps.launchPersistentContext;
 const identity={schema:1,os:"macos",preset:{vendor:"same-pinned-identity"}} as const;
 let launched=0;
 try {
  chatGptBrowserDeps.loadIdentity=async()=>identity as any;
  chatGptBrowserDeps.launchPersistentContext=async(path,config)=>{
   launched++;
   assert.equal(path,"/tmp");
   assert.equal(config.headless,false);
   assert.equal(config.timeout,3200);
   assert.equal(config.identity,identity);
   return {} as any;
  };
  await launchVisibleStagingCamoufox("/tmp",3200);
  assert.equal(launched,1);
 }finally{
  chatGptBrowserDeps.loadIdentity=originalLoad;
  chatGptBrowserDeps.launchPersistentContext=originalLaunch;
 }
});

test("every live staging ChatGPT probe avoids hidden Camoufox overrides",async()=>{
 for(const file of [
  "live-staging-chatgpt.smoke.ts","live-staging-composer.smoke.ts",
  "live-qa-run02-readonly.smoke.ts","live-browser-worker-transport.smoke.ts"
 ]){
  const source=await readFile("tests/"+file,"utf8");
  assert.doesNotMatch(source,/headless\s*:\s*true/);
  assert.doesNotMatch(source,/getRandomPreset\(/);
  assert.match(source,/STAGING_QA_HEADLESS|launchVisibleStagingCamoufox/);
 }
});
