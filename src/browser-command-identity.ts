import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Transport-neutral identity checks for CoS-inspired command claims.
 *
 * No side effects, browser process, socket, outbox, authentication, persistence
 * or recovery ownership are introduced here. A caller MUST obtain claim and
 * observed document/receipt from independently trusted host/provider sources.
 * An object matching this shape is NOT itself proof or permission to Send.
 *
 * The native broker verifies the owner-key MAC and exact active graph identity
 * before durably claiming a command; page/document evidence is checked again
 * at the same side-effect boundary.
 */
export interface BrowserDocumentClaim {
  repo:string;issue:number;pr:number|null;workerId:string;turn:number;commandId:string;
  reportTokenHash:string;graphSha256:string;workerManifestSha256:string;authorizationMac:string;
  purpose?:"worker_turn"|"owner_wakeup";
  ownerFingerprint?:string;ownerBindingSha256?:string;
  runtimeIncarnation:string;profileOwner:string;
  windowLease:string;tabLease:string;documentId:string;
  navigationEpoch:number;conversationId:string|undefined;
  payloadSha256:string;
}
export type BrowserDocumentObservation=Pick<BrowserDocumentClaim,
  "repo"|"issue"|"workerId"|"runtimeIncarnation"|"profileOwner"|
  "windowLease"|"tabLease"|"documentId"|"navigationEpoch"|"conversationId">;
export type BrowserProviderReceiptIdentity=Pick<BrowserDocumentClaim,
  "repo"|"issue"|"workerId"|"turn"|"commandId"|"payloadSha256"> & {
  purpose?:"worker_turn"|"owner_wakeup";
  ownerFingerprint?:string;ownerBindingSha256?:string;
  conversationId:string;messageId:string;
};

const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID=/^[A-Za-z0-9_.:-]{1,192}$/;
const HEX=/^[a-f0-9]{64}$/;
const DOCUMENT_KEYS=[
  "repo","issue","workerId","runtimeIncarnation","profileOwner",
  "windowLease","tabLease","documentId","navigationEpoch","conversationId",
] as const;
const RECEIPT_KEYS=["repo","issue","workerId","turn","commandId",
  "payloadSha256","conversationId"] as const;

/** Equality of identities, not endorsement of any self-declared evidence. */
function validClaim(claim:BrowserDocumentClaim):boolean{
  const purpose=claim?.purpose??"worker_turn";
  const principalValid=purpose==="worker_turn"
    ? claim?.ownerFingerprint===undefined&&claim?.ownerBindingSha256===undefined
    : purpose==="owner_wakeup"&&claim?.workerId==="main_agent_owner"&&
      /^chat_[a-f0-9]{64}$/.test(claim.ownerFingerprint??"")&&HEX.test(claim.ownerBindingSha256??"");
  return !!claim && principalValid && REPO.test(claim.repo) &&
    Number.isSafeInteger(claim.issue)&&claim.issue>0&&
    (claim.pr===null||(Number.isSafeInteger(claim.pr)&&claim.pr>0))&&
    Number.isSafeInteger(claim.turn)&&claim.turn>=0&&
    HEX.test(claim.reportTokenHash)&&HEX.test(claim.graphSha256)&&
    HEX.test(claim.workerManifestSha256)&&HEX.test(claim.authorizationMac)&&
    Number.isSafeInteger(claim.navigationEpoch)&&claim.navigationEpoch>=0&&
    ["workerId","commandId","runtimeIncarnation","profileOwner","windowLease",
      "tabLease","documentId"].every(key=>ID.test(claim[key as keyof BrowserDocumentClaim] as string))&&
    (claim.conversationId===undefined||ID.test(claim.conversationId))&&
    HEX.test(claim.payloadSha256);
}

export function assertBrowserDocumentClaim(claim:BrowserDocumentClaim,
  observed:BrowserDocumentObservation):true{
  if(!validClaim(claim)||!observed||
     !Number.isSafeInteger(observed.navigationEpoch)||
     DOCUMENT_KEYS.some(key=>observed[key]!==claim[key]))
    throw new Error("Browser command ownership evidence does not match exact durable document claim");
  return true;
}

export type BrowserCommandAuthorization = Pick<BrowserDocumentClaim,
  "repo"|"issue"|"pr"|"workerId"|"turn"|"commandId"|"reportTokenHash"|"graphSha256"|"workerManifestSha256"> &
  Pick<BrowserDocumentClaim,"purpose"|"ownerFingerprint"|"ownerBindingSha256">;

function authorizationPayload(value: BrowserCommandAuthorization): string {
  return JSON.stringify({
    repo:value.repo, issue:value.issue, pr:value.pr, workerId:value.workerId, turn:value.turn,
    commandId:value.commandId, reportTokenHash:value.reportTokenHash,
    graphSha256:value.graphSha256, workerManifestSha256:value.workerManifestSha256,
    purpose:value.purpose??"worker_turn",
    ownerFingerprint:value.ownerFingerprint??null,
    ownerBindingSha256:value.ownerBindingSha256??null,
  });
}

export function signBrowserCommandAuthorization(value: BrowserCommandAuthorization, ownerSecret: string): string {
  if (Buffer.byteLength(ownerSecret) < 32) throw new Error("Strong local owner secret required for browser command authorization");
  const key=createHmac("sha256", createHash("sha256").update("DevOS browser command authorization v1\0").update(ownerSecret).digest());
  return key.update(authorizationPayload(value)).digest("hex");
}

export function verifyBrowserCommandAuthorization(claim: BrowserDocumentClaim, ownerSecret: string): boolean {
  if (!claim || !HEX.test(claim.authorizationMac) || !HEX.test(claim.reportTokenHash) ||
      !HEX.test(claim.graphSha256) || !HEX.test(claim.workerManifestSha256) ||
      !(claim.pr===null||(Number.isSafeInteger(claim.pr)&&claim.pr>0))||!validClaim(claim)) return false;
  try {
    const expected=signBrowserCommandAuthorization(claim,ownerSecret);
    return timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(claim.authorizationMac,"hex"));
  } catch { return false; }
}

/** A matching ID is insufficient to claim a provider message was sent: the
 * trusted browser adapter must independently prove its actual origin. */
export function matchBrowserReceiptIdentity(claim:BrowserDocumentClaim,
  receipt:BrowserProviderReceiptIdentity):true{
  const purpose=claim?.purpose??"worker_turn";
  if(!validClaim(claim)||!receipt||
     !ID.test(receipt.messageId)||
     (receipt.purpose??"worker_turn")!==purpose||
     receipt.ownerFingerprint!==claim.ownerFingerprint||
     receipt.ownerBindingSha256!==claim.ownerBindingSha256||
     RECEIPT_KEYS.some(key=>key==="conversationId"
       ? (claim.conversationId!==undefined&&receipt.conversationId!==claim.conversationId)
       : receipt[key]!==claim[key]))
    throw new Error("Browser provider receipt identity is missing, conflicting or unverified");
  return true;
}
