import assert from "node:assert/strict";
import test from "node:test";
import {chatGptBrowserDeps} from "../src/chatgpt-browser-executor.js";
import {stagingQaHeadless,launchStagingCamoufox} from "./staging-headed-launch.js";
import {readFile} from "node:fs/promises";

test("Staging QA defaults to headed, allows explicit headless=1 and validates values",()=>{
 assert.equal(stagingQaHeadless({}),false);
 assert.equal(stagingQaHeadless({DEVOS_BROWSER_HEADLESS:"0"}),false);
 assert.equal(stagingQaHeadless({DEVOS_BROWSER_HEADLESS:"1"}),true);
 assert.throws(()=>stagingQaHeadless({DEVOS_BROWSER_HEADLESS:"yes"}),
   /DEVOS_BROWSER_HEADLESS must be 0 or 1/);
});

test("QA reuses DevOS v1 persistent launch and fingerprint in both modes",async()=>{
 const originalLoad=chatGptBrowserDeps.loadIdentity;
 const originalLaunch=chatGptBrowserDeps.launchPersistentContext;
 const identity={schema:1,os:"macos",preset:{vendor:"same-pinned-identity"}} as const;
 const modes:boolean[]=[];
 try {
  chatGptBrowserDeps.loadIdentity=async()=>identity as any;
  chatGptBrowserDeps.launchPersistentContext=async(path,config)=>{
   assert.equal(path,"/tmp");
   assert.equal(config.timeout,3200);
   assert.equal(config.identity,identity);
   modes.push(config.headless);
   return {} as any;
  };
  await launchStagingCamoufox("/tmp",3200,{DEVOS_BROWSER_HEADLESS:"0"});
  await launchStagingCamoufox("/tmp",3200,{DEVOS_BROWSER_HEADLESS:"1"});
  assert.deepEqual(modes,[false,true]);
 }finally{
  chatGptBrowserDeps.loadIdentity=originalLoad;
  chatGptBrowserDeps.launchPersistentContext=originalLaunch;
 }
});

test("live Staging ChatGPT probes use shared configurable mode, not hardcoded mode",async()=>{
 for(const file of [
  "live-staging-chatgpt.smoke.ts","live-staging-composer.smoke.ts",
  "live-qa-run02-readonly.smoke.ts","live-browser-worker-transport.smoke.ts"
 ]){
  const source=await readFile("tests/"+file,"utf8");
  assert.doesNotMatch(source,/headless\s*:\s*(?:true|false)/);
  assert.doesNotMatch(source,/getRandomPreset\(/);
  assert.match(source,/stagingQaHeadless|launchStagingCamoufox/);
 }
});
