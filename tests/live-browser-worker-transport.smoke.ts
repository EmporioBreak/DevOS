/** Opt-in benign project-chat round trip through REAL Camoufox.
 * Uses only the copied STAGING browser profile. No MCP tools, no code or GitHub writes.
 * Never prints URL, raw model responses, cookies or auth data.
 */
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {ChatGptBrowserExecutor} from "../src/chatgpt-browser-executor.js";
import {assertChatGptProjectScope} from "../src/browser-config.js";
import {stagingQaPrompt,verifyStagingQaAnswer} from "./qa-transport-contract.js";
import {STAGING_QA_HEADLESS} from "./staging-headed-launch.js";

const root=process.env.DEVOS_STAGING_ROOT;
if(!root || !root.endsWith("/DevOS-staging"))
 throw new Error("Explicit DEVOS_STAGING_ROOT=.../DevOS-staging required; refusing non-staging checkout");
const qaDir=join(root,".devos","qa");
await mkdir(qaDir,{recursive:true,mode:0o700});
const oneShot=join(qaDir,"live-chatgpt-transport-20261009.json");
// Persist intent BEFORE any potentially irreversible DOM submit. If a
// previous attempt is uncertain, never create another chat on rerun.
try {
 await writeFile(oneShot,JSON.stringify({schema:1,stage:"started",replay:"forbidden"})+"\n",
   {flag:"wx",mode:0o600});
} catch(error) {
 if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
 // A previous attempt may have sent a ChatGPT message. Never send twice.
 console.log(JSON.stringify({roundtrip:"not_retried",
   reason:"one_shot_sentinel_present",productionUntouched:true}));
 process.exit(2);
}
const config=JSON.parse(await readFile(join(root,".devos","config.json"),"utf8"));
const profileDir=join(homedir(),".devos-staging","camoufox-profile");
const executor=new ChatGptBrowserExecutor({
 projectUrl:config.chatgptProjectUrl,profileDir,headless:STAGING_QA_HEADLESS,
},100_000);
let saved:string|undefined;
let attemptedTurns=0,completedTurns=0;
const prompt=stagingQaPrompt;
try{
 const first="DEVOS_STAGING_QA_ROUNDTRIP_ONE";
 attemptedTurns++;
 const result=await executor.run({projectRoot:root,workerId:"staging_qa",
   prompt:prompt(first),enforceProjectScope:true,
   browserTurnId:"staging-qa-once-1",
   onSession:async (url)=>{
     assertChatGptProjectScope(config.chatgptProjectUrl,url,true);saved=url;
     // Private local state, never a public GitHub report or stdout.
     const savedFile=join(qaDir,"live-transport-saved-chat.url");
     try {await writeFile(savedFile,url+"\n",{flag:"wx",mode:0o600});}
     catch(error){
       if((error as NodeJS.ErrnoException).code!=="EEXIST" ||
          (await readFile(savedFile,"utf8"))!==url+"\n")
         throw new Error("Persisted Staging QA conversation differs from current turn");
     }
   },
 });
 completedTurns++;
 if(!saved || result.sessionId!==saved || !verifyStagingQaAnswer(result.text,first))
   throw new Error("First ChatGPT project worker roundtrip could not be verified");
 const second="DEVOS_STAGING_QA_ROUNDTRIP_TWO";
 attemptedTurns++;
 const continued=await executor.run({projectRoot:root,workerId:"staging_qa",
   prompt:prompt(second),sessionId:saved,enforceProjectScope:true,
   browserTurnId:"staging-qa-once-2",onSession:async (url)=>{
      assertChatGptProjectScope(config.chatgptProjectUrl,url,true);
      if(url!==saved)throw new Error("Saved conversation changed on resume");
   },
 });
 completedTurns++;
 if(continued.sessionId!==saved || !verifyStagingQaAnswer(continued.text,second))
   throw new Error("Resumed Project chat roundtrip could not be verified");
 console.log(JSON.stringify({realCamoufox:true,stagingProfileOnly:true,
   projectChatCreated:true,sameExactChatOnResume:true,
   matchedTwoBenignResponses:true,attemptedTurns,completedTurns,productionUntouched:true,
   fullFeatureE2E:false}));
}catch(e){
 const message=String(e instanceof Error?e.message:e);
 const reason=/auth|login|challenge/i.test(message)?"authentication":
   /timeout|deadline/i.test(message)?"deadline":
   /post-submit|submitted|turn|identity/i.test(message)?"ambiguous_or_identity":"browser_transport";
 console.log(JSON.stringify({realCamoufox:true,stagingProfileOnly:true,
   roundtrip:"blocked",category:reason,attemptedTurns,completedTurns,
   mayHaveSubmitted:attemptedTurns>completedTurns,fullFeatureE2E:false}));
 process.exitCode=2;
}finally{await executor.close().catch(()=>undefined);}
