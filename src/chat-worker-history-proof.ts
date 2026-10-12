import { canonicalPrivateChatUrl } from "./chat-access.js";
import { exactWorkerProbeResult } from "./chat-worker-probe.js";

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A history mapping is a graph, not a chronological array. A candidate tool
 * result is eligible only when its ancestor chain reaches this exact user turn
 * without crossing another user message, missing parent or cycle. */
function mappingWorkerProbeProof(
  mapping: Record<string, any>, submittedId: string | undefined,
  exactPrompt: string | undefined, resourceUri: string,
): string | null {
  const keys = Object.keys(mapping);
  if (keys.length > 10_000) return null;
  const canonical = (v: string) => v.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").normalize("NFC").trim();
  const users = keys.filter(key => {
    const entry = mapping[key];
    if (!record(entry) || !record(entry.message) ||
        entry.message.author?.role !== "user") return false;
    if (submittedId) return entry.message.id === submittedId;
    const parts = entry.message.content?.parts;
    return !!exactPrompt && Array.isArray(parts) && parts.length > 0 &&
      parts.every((p: unknown) => typeof p === "string") &&
      canonical(parts.join("")) === canonical(exactPrompt);
  });
  if (users.length !== 1) return null;
  const userKey = users[0]!;
  let candidate: string | null = null;
  for (const key of keys) {
    const entry = mapping[key];
    if (key === userKey || !record(entry) || !record(entry.message) ||
        entry.message.author?.role !== "tool") continue;
    const seen = new Set([key]);
    let parent: unknown = entry.parent;
    let belongsToTurn = false;
    while (typeof parent === "string" && !seen.has(parent)) {
      if (parent === userKey) { belongsToTurn = true; break; }
      seen.add(parent);
      if (!Object.prototype.hasOwnProperty.call(mapping, parent)) break;
      const ancestor = mapping[parent];
      if (!record(ancestor) || !record(ancestor.message) ||
          ancestor.message.author?.role === "user") break;
      parent = ancestor.parent;
    }
    if (!belongsToTurn) continue;
    const nonce = exactWorkerProbeResult(entry.message, resourceUri);
    if (!nonce) continue;
    if (candidate && candidate !== nonce) return null;
    candidate = nonce;
  }
  return candidate;
}

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
  if ((obj.conversation_id ?? obj.id) !== conversationId ||
      (obj.id !== undefined && obj.id !== conversationId) ||
      (obj.conversation_id !== undefined && obj.conversation_id !== conversationId)) return null;
  // Conflicting representations are ambiguous; never choose whichever grants.
  if ((obj.mapping !== undefined && obj.messages !== undefined) ||
      (obj.mapping !== undefined && !record(obj.mapping))) return null;
  if (record(obj.mapping))
    return mappingWorkerProbeProof(obj.mapping,
      idValid ? submittedUserMessageId : undefined,
      promptValid ? exactSubmittedPrompt : undefined, pinnedResourceUri);
  if (!Array.isArray(obj.messages) || obj.messages.length>10000) return null;
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

/**
 * A real provider GET/history response can prove that the exact outgoing
 * user-message ID reached the original saved ChatGPT conversation. An
 * intercepted POST payload, click event, or assistant text alone cannot.
 *
 * Reject duplicate IDs, prompt/content mismatch, foreign conversation,
 * conflicting history shapes and unknown structured parts.
 */
export function exactProviderAcceptedUserMessage(
  response: unknown, exactChatUrl: string, outgoingMessageId: string,
  exactPrompt: string,
): string | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(outgoingMessageId) ||
      typeof exactPrompt !== "string" || !exactPrompt.trim() ||
      exactPrompt.length > 250_000) return null;
  let chatId:string;
  try {
    if (canonicalPrivateChatUrl(exactChatUrl) !== exactChatUrl) return null;
    chatId=new URL(exactChatUrl).pathname.split("/c/")[1] ?? "";
    if (!chatId || chatId.includes("/")) return null;
  } catch {return null;}
  if (!record(response)) return null;
  if ((response.conversation_id ?? response.id) !== chatId ||
      (response.conversation_id !== undefined && response.conversation_id !== chatId) ||
      (response.id !== undefined && response.id !== chatId) ||
      (response.mapping !== undefined && response.messages !== undefined)) return null;
  const normalize=(s:string)=>s.replace(/\r\n?/g,"\n").replace(/\u00a0/g," ").normalize("NFC").trim();
  const accept=(m:unknown):boolean=>{
    if(!record(m)||m.author?.role!=="user"||m.id!==outgoingMessageId)return false;
    const parts=m.content?.parts;
    return Array.isArray(parts) && parts.length>0 &&
      parts.every((p:unknown)=>typeof p==="string") &&
      normalize(parts.join(""))===normalize(exactPrompt);
  };
  let messages:unknown[];
  if(response.mapping!==undefined){
    if(!record(response.mapping)||Object.keys(response.mapping).length>10_000)return null;
    messages=Object.values(response.mapping).map(entry=>record(entry)?entry.message:null);
  }else{
    if(!Array.isArray(response.messages)||response.messages.length>10_000)return null;
    messages=response.messages.map((entry:unknown)=>record(entry)?entry.message??entry:entry);
  }
  return messages.filter(accept).length===1 ? outgoingMessageId : null;
}
