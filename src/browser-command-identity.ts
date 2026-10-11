/** Transport-neutral identity checks for CoS-inspired command claims.
 *
 * No side effects, browser process, socket, outbox, authentication, persistence
 * or recovery ownership are introduced here. A caller MUST obtain claim and
 * observed document/receipt from independently trusted host/provider sources.
 * An object matching this shape is NOT itself proof or permission to Send.
 *
 * Future authoritative browser broker must recheck the original durable claim
 * at the native side-effect boundary, not merely when observing a page.
 */
export interface BrowserDocumentClaim {
  repo:string;issue:number;workerId:string;turn:number;commandId:string;
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
  return !!claim && REPO.test(claim.repo) &&
    Number.isSafeInteger(claim.issue)&&claim.issue>0&&
    Number.isSafeInteger(claim.turn)&&claim.turn>0&&
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

/** A matching ID is insufficient to claim a provider message was sent: the
 * trusted browser adapter must independently prove its actual origin. */
export function matchBrowserReceiptIdentity(claim:BrowserDocumentClaim,
  receipt:BrowserProviderReceiptIdentity):true{
  if(!validClaim(claim)||!receipt||
     !ID.test(receipt.messageId)||
     RECEIPT_KEYS.some(key=>key==="conversationId"
       ? (claim.conversationId!==undefined&&receipt.conversationId!==claim.conversationId)
       : receipt[key]!==claim[key]))
    throw new Error("Browser provider receipt identity is missing, conflicting or unverified");
  return true;
}
