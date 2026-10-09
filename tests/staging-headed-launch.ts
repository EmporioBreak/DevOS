/** Staging QA uses the normal DevOS browser option: headed by default,
 * optional headless via DEVOS_BROWSER_HEADLESS=1. Never rotate fingerprint.
 * This helper creates no process until invoked by a live smoke.
 */
import {mkdir} from "node:fs/promises";
import {chatGptBrowserDeps} from "../src/chatgpt-browser-executor.js";
import {loadChatGptBrowserConfig} from "../src/browser-config.js";

export function stagingQaHeadless(env:Record<string,string|undefined>=process.env):boolean{
 return loadChatGptBrowserConfig(env).headless;
}

export async function launchStagingCamoufox(
 profileDir:string,timeout=20_000,env:Record<string,string|undefined>=process.env,
){
 await mkdir(profileDir,{recursive:true});
 const identity=await chatGptBrowserDeps.loadIdentity(profileDir);
 return chatGptBrowserDeps.launchPersistentContext(profileDir,{
   headless:stagingQaHeadless(env),timeout,identity,
 });
}
