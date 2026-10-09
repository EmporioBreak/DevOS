/** Staging QA browser mode must match the working DevOS v1 headed
 * persistent Camoufox launcher (including its saved fingerprint).
 * This helper creates no process until explicitly called by a smoke.
 */
import {mkdir} from "node:fs/promises";
import {chatGptBrowserDeps} from "../src/chatgpt-browser-executor.js";

export const STAGING_QA_HEADLESS=false as const;

export async function launchVisibleStagingCamoufox(profileDir:string,timeout=20_000){
 await mkdir(profileDir,{recursive:true});
 const identity=await chatGptBrowserDeps.loadIdentity(profileDir);
 return chatGptBrowserDeps.launchPersistentContext(profileDir,{
   headless:STAGING_QA_HEADLESS,timeout,identity,
 });
}
