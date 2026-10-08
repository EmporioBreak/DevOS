import { canonicalPrivateChatUrl } from "./chat-access.js";
import { exactWorkerProbeResult } from "./chat-worker-probe.js";

/** A provider-authored read-only response for the exact saved conversation,
 * NOT scraped DOM, assistant text, user arguments, or sidebar traversal.
 * Only tool results after this specific submitted user message, and before
 * the next user message, are eligible for one-turn ownership evidence. */
export function exactWorkerHistoryProof(
  response: unknown, exactChatUrl: string, submittedUserMessageId: string | undefined, pinnedResourceUri: string,
  exactSubmittedPrompt?: string,
): string | null {
  const idValid=typeof submittedUserMessageId==="string" && /^[A-Za-z0-9_-]{1,200}$/.test(submittedUserMessageId);
  const promptValid=typeof exactSubmittedPrompt==="string" && exactSubmittedPrompt.length>0 && exactSubmittedPrompt.length<=250_000;
  if (!idValid && !promptValid) return null;
  let conversationId: string | undefined;
  try {
    if (canonicalPrivateChatUrl(exactChatUrl)!==exactChatUrl) return null;
    conversationId=/\/c\/([^/?#]+)$/.exec(new URL(exactChatUrl).pathname)?.[1];
  } catch { return null; }
  if (!conversationId || !response || typeof response !== "object" || Array.isArray(response)) return null;
  const obj=response as Record<string,unknown>;
  if (obj.conversation_id!==conversationId || !Array.isArray(obj.messages) ||
      obj.messages.length>10000) return null;
  const messages=obj.messages.map((v:any)=>v?.message||v);
  const canonical=(v:string)=>v.replace(/\r\n?/g,"\n").replace(/\u00a0/g," ").normalize("NFC").trim();
  const indices=messages.map((m:any,i:number)=>{
    if(m?.author?.role!=="user") return -1;
    if(idValid) return m.id===submittedUserMessageId?i:-1;
    const parts=m.content?.parts;
    return Array.isArray(parts) && parts.length>0 && parts.every((p:unknown)=>typeof p==="string") &&
      canonical(parts.join(""))===canonical(exactSubmittedPrompt!) ? i:-1;
  }).filter((i:number)=>i>=0);
  if (indices.length!==1) return null;
  let candidate: string | null=null;
  for (let i=indices[0]!+1;i<messages.length;i++){
    const m=messages[i];
    if (m?.author?.role==="user") break;
    const nonce=exactWorkerProbeResult(m,pinnedResourceUri);
    if (!nonce) continue;
    if (candidate && candidate!==nonce) return null; // contradicting evidence
    candidate=nonce;
  }
  return candidate;
}
