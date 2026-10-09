/** Read-only second one-shot QA inspection: never posts, fills or presses. */
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {launchStagingCamoufox} from "./staging-headed-launch.js";
import {assertChatGptProjectScope} from "../src/browser-config.js";
import {readExactDomFinal} from "../src/chatgpt-dom-recovery.js";
import {isSameChatGptConversation} from "../src/chatgpt-browser-executor.js";
import {stagingQaPrompt} from "./qa-transport-contract.js";
const root=process.env.DEVOS_STAGING_ROOT;
if(!root || !root.endsWith("/DevOS-staging"))
 throw new Error("Explicit isolated Staging root required");
const config=JSON.parse(await readFile(join(root,".devos","config.json"),"utf8"));
const file=join(root,".devos","qa","live-transport-run02-chat.url");
const url=(await readFile(file,"utf8")).trim();
assertChatGptProjectScope(config.chatgptProjectUrl,url,true);
const prompt=stagingQaPrompt("DEVOS_STAGING_QA_ROUNDTRIP_THREE");
let context;
try {
 context=await launchStagingCamoufox(
   join(homedir(),".devos-staging","camoufox-profile"),20000);
 const page=context.pages()[0]??await context.newPage();
 const response=await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
 await page.waitForTimeout(5000);
 const same=isSameChatGptConversation(url,page.url());
 const counts=await page.evaluate((expectedPrompt)=>{
  const visible=(n:Element)=>(n as HTMLElement).getClientRects().length>0;
  const items=Array.from(document.querySelectorAll(
    '[data-message-author-role="user"],[data-message-author-role="assistant"]')).filter(visible);
  const users=items.filter(n=>n.getAttribute("data-message-author-role")==="user"&&
      (n as HTMLElement).innerText.trim()===expectedPrompt.trim());
  const pos=users.length===1?items.indexOf(users[0]!):-1;
  const assistant=pos<0?[]:items.slice(pos+1).filter(n=>
      n.getAttribute("data-message-author-role")==="assistant");
  const last=assistant.at(-1);
  const lastLine=last?(last as HTMLElement).innerText.trim().split(/\r?\n/).at(-1):"";
  const generating=Array.from(document.querySelectorAll(
    '[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]')).some(visible);
  return {exactUserMatches:users.length,assistantAfter:assistant.length,
      canonicalTerminalLine:lastLine==='DEVOS_RESULT {"status":"done"}',
      generating};
 },prompt);
 const recovered=await readExactDomFinal(page,prompt,5000);
 console.log(JSON.stringify({stagingOnly:true,readOnly:true,resourceStatus:response?.status()??null,
   exactSavedProjectConversation:same,...counts,
   exactDomRecoveryAccepted:!!recovered,messageSent:false,rawContentPublished:false}));
}catch(e) {
 const text=String(e instanceof Error?e.message:e);
 const kind=/timeout/i.test(text)?"timeout":/scope|conversation|URL/i.test(text)?"identity":"navigation";
 console.log(JSON.stringify({stagingOnly:true,readOnly:true,result:"blocked",category:kind,messageSent:false}));
 process.exitCode=2;
}finally{await context?.close().catch(()=>undefined)}
