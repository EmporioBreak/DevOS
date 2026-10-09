/** Read-only composer readiness: no click/fill/send, staging Camoufox ONLY. */
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {launchVisibleStagingCamoufox} from "./staging-headed-launch.js";
const root=process.env.DEVOS_STAGING_ROOT;
if(!root||!root.endsWith("/DevOS-staging"))
 throw new Error("Explicit isolated DevOS-staging root required");
const conf=JSON.parse(await readFile(join(root,".devos","config.json"),"utf8"));
const url=conf.chatgptProjectUrl;
if(typeof url!=="string"||!/^https:\/\/chatgpt\.com\/g\//.test(url))
 throw new Error("Unsafe ChatGPT target");
const profile=join(homedir(),".devos-staging","camoufox-profile");
let context;
try{
 context=await launchVisibleStagingCamoufox(profile,20000);
 const page=context.pages()[0]??await context.newPage();
 await page.goto(url,{waitUntil:"domcontentloaded",timeout:25000});
 await page.waitForTimeout(6000);
 const current=page.url();
 const editorSelectors=[
  '[data-testid="prompt-textarea"]',
  '#prompt-textarea',
  'textarea[placeholder*="Message"]',
  '[contenteditable="true"]',
 ];
 const buttonSelectors=[
  '#composer-submit-button',
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[type="submit"][aria-label="Отправить"]',
 ];
 let visibleEditor=false,visibleSend=false;
 for(const selector of editorSelectors){
  const el=page.locator(selector).first();
  if(await el.isVisible().catch(()=>false)){visibleEditor=true;break;}
 }
 for(const selector of buttonSelectors){
  const el=page.locator(selector).first();
  if(await el.isVisible().catch(()=>false)){visibleSend=true;break;}
 }
 const otherProject=/^https:\/\/chatgpt\.com\/g\//.test(current)===false;
 console.log(JSON.stringify({staging:true,readOnly:true,
  projectNavigation:true,validProjectOrigin:!otherProject,
  editorVisible:visibleEditor,sendControlVisible:visibleSend,
  authenticatedAndReady:!otherProject&&visibleEditor,
  messageSent:false}));
 if(otherProject||!visibleEditor)process.exitCode=2;
}catch(e){
 const msg=String(e instanceof Error?e.message:e);
 console.log(JSON.stringify({staging:true,readOnly:true,
  status:"blocked",category:/timeout/i.test(msg)?"timeout":"navigation",messageSent:false}));
 process.exitCode=2;
}finally{await context?.close().catch(()=>undefined)}
