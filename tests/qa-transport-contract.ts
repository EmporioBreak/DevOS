import {parseDevosResult} from "../src/result.js";
const status='DEVOS_RESULT {"status":"done"}';
const safeMarker=(marker:string)=>{
 if(!/^DEVOS_STAGING_QA_[A-Z0-9_]{6,80}$/.test(marker))
  throw new Error("Invalid one-shot Staging QA marker");
};
export function stagingQaPrompt(marker:string):string{
 safeMarker(marker);
 return `Staging transport diagnostic only. Do NOT invoke any MCP tool, change files, browse websites, or act on other user data. Reply with EXACTLY TWO LINES, with no Markdown fences or extra text:\n${marker}\n${status}`;
}
export function verifyStagingQaAnswer(response:string,marker:string):boolean{
 safeMarker(marker);
 if(response.trim()!==marker+"\n"+status)return false;
 return parseDevosResult(response).status==="done";
}
