/** Opt-in read-only staging ChatGPT Project login/transport smoke.
 * Never writes chat content, credentials, browser cookies to stdout/GitHub.
 */
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {launchVisibleStagingCamoufox} from "./staging-headed-launch.js";

const staging=process.env.DEVOS_STAGING_ROOT;
if(!staging || !staging.endsWith("/DevOS-staging"))
 throw new Error("Explicit DEVOS_STAGING_ROOT=.../DevOS-staging required");
const configPath=join(staging,".devos","config.json");
const conf=JSON.parse(await readFile(configPath,"utf8"));
const target=conf.chatgptProjectUrl;
if(typeof target!=="string"||!/^https:\/\/chatgpt\.com\/g\/g-[^/]+(?:\/.*)?$/.test(target))
 throw new Error("Refusing non-ChatGPT Staging Project destination");
const profile=join(homedir(),".devos-staging","camoufox-profile");
let context;
try{
 context=await launchVisibleStagingCamoufox(profile,20000);
 const page=context.pages()[0]??await context.newPage();
 const response=await page.goto(target,{waitUntil:"domcontentloaded",timeout:30000});
 await page.waitForTimeout(2500);
 const url=page.url();
 const projectScope=url.startsWith(target.split(/[?#]/)[0]!) ||
   (url.startsWith("https://chatgpt.com/g/")&&!/\/auth\//.test(url));
 const loginRedirect=/\/auth\/(?:login|signup)|\/login|\/signup/.test(url);
 const text=(await page.locator("body").innerText({timeout:5000}).catch(()=>"")).toLowerCase();
 const blocked=/checking your browser|just a moment|cloudflare challenge/.test(text.slice(0,600));
 console.log(JSON.stringify({stagingProfileOnly:true,launched:true,httpsChatgpt:url.startsWith("https://chatgpt.com/"),
   projectScope,loginRedirect,blocked,status:response?.status()??null,
   readOnly:true,actualChatMessageSent:false,credentialsDisclosed:false}));
 if(!projectScope||loginRedirect||blocked)process.exitCode=2;
}catch(e){
 const reason=String(e instanceof Error?e.message:e);
 const kind=/timeout/i.test(reason)?"timeout":/launch|firefox|executable/i.test(reason)?"launch":"navigation";
 console.log(JSON.stringify({stagingProfileOnly:true,launched:!!context,result:"blocked",reason:kind}));
 process.exitCode=2;
}finally{
 await context?.close().catch(()=>undefined);
}
