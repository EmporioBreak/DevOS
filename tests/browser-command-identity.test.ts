import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBrowserDocumentClaim,
  matchBrowserReceiptIdentity,
  signBrowserCommandAuthorization,
  verifyBrowserCommandAuthorization,
  type BrowserDocumentClaim,
  type BrowserDocumentObservation,
  type BrowserProviderReceiptIdentity,
} from "../src/browser-command-identity.js";

const claim:BrowserDocumentClaim={
  repo:"EmporioBreak/DevOS",issue:239,pr:240,workerId:"cos_browser_qa",turn:4,
  reportTokenHash:"b".repeat(64),graphSha256:"c".repeat(64),workerManifestSha256:"d".repeat(64),
  authorizationMac:"", 
  commandId:"command-4",runtimeIncarnation:"runtime-original",
  profileOwner:"profile-original",windowLease:"window-239",
  tabLease:"tab-worker-239",documentId:"document-A",navigationEpoch:7,
  conversationId:"chat-a",payloadSha256:"a".repeat(64),
};
claim.authorizationMac=signBrowserCommandAuthorization(claim,"test-owner-secret-that-is-at-least-thirty-two-bytes");
const observation:BrowserDocumentObservation={
  repo:claim.repo,issue:claim.issue,workerId:claim.workerId,
  runtimeIncarnation:claim.runtimeIncarnation,
  profileOwner:claim.profileOwner,windowLease:claim.windowLease,
  tabLease:claim.tabLease,documentId:claim.documentId,
  navigationEpoch:claim.navigationEpoch,conversationId:claim.conversationId,
};

test("browser command side effects require matching every project/task/worker/window/tab/document/epoch owner",()=>{
  assert.equal(assertBrowserDocumentClaim(claim,observation),true);
  const replacements=[
    {repo:"Foreign/Project"},{issue:240},{workerId:"cos_browser_qa_other"},
    {runtimeIncarnation:"restarted-runtime"},{profileOwner:"borrowed-profile"},
    {windowLease:"another-window"},{tabLease:"another-tab"},
    {documentId:"same-url-new-document"},{navigationEpoch:8},
    {conversationId:"chat-b"},
  ];
  for(const patch of replacements){
    assert.throws(()=>assertBrowserDocumentClaim(claim,{...observation,...patch}),
      /browser command ownership/i,JSON.stringify(patch));
  }
});

test("A→B→A restores original conversation URL but never restores stale document/action authority",()=>{
  const returnedToA={...observation,documentId:"document-A2",navigationEpoch:9};
  assert.equal(returnedToA.conversationId,observation.conversationId);
  assert.throws(()=>assertBrowserDocumentClaim(claim,returnedToA),/browser command ownership/i);
  const reloadedA={...observation,navigationEpoch:8};
  assert.throws(()=>assertBrowserDocumentClaim(claim,reloadedA),/browser command ownership/i);
});

test("provider message receipt requires exact command, turn, conversation and payload; no wildcard identity",()=>{
  const receipt:BrowserProviderReceiptIdentity={
    repo:claim.repo,issue:claim.issue,workerId:claim.workerId,turn:claim.turn,
    commandId:claim.commandId,conversationId:claim.conversationId!,
    messageId:"provider-user-msg-4",payloadSha256:claim.payloadSha256,
  };
  assert.equal(matchBrowserReceiptIdentity(claim,receipt),true);
  for(const patch of [
    {repo:"Foreign/Project"},{issue:240},{workerId:"unrelated"},
    {turn:3},{commandId:"other-command"},{conversationId:"other-chat"},
    {messageId:""},{payloadSha256:"b".repeat(64)},
  ])assert.throws(()=>matchBrowserReceiptIdentity(claim,{...receipt,...patch}),
    /browser provider receipt/i);
});

test("a fresh Project claim binds its newly assigned conversation through the exact provider receipt",()=>{
  const freshClaim={...claim,conversationId:undefined};
  const createdConversationReceipt:BrowserProviderReceiptIdentity={
    repo:claim.repo,issue:claim.issue,workerId:claim.workerId,turn:claim.turn,
    commandId:claim.commandId,conversationId:"provider-created-conversation",
    messageId:"provider-user-msg-4",payloadSha256:claim.payloadSha256,
  };
  assert.equal(matchBrowserReceiptIdentity(freshClaim,createdConversationReceipt),true);
  assert.throws(()=>matchBrowserReceiptIdentity(freshClaim,{...createdConversationReceipt,commandId:"other-command"}),/browser provider receipt/i);
});

test("owner wake-up authorization binds the exact signed owner chat and review round",()=>{
  const secret="test-owner-secret-that-is-at-least-thirty-two-bytes";
  const ownerClaim:BrowserDocumentClaim={...claim,purpose:"owner_wakeup",
    workerId:"main_agent_owner",turn:2,commandId:"owner-wakeup-239-round-2",
    ownerFingerprint:"chat_"+"e".repeat(64),ownerBindingSha256:"f".repeat(64),
    reportTokenHash:"1".repeat(64),conversationId:"owner-conversation",
  };
  ownerClaim.authorizationMac=signBrowserCommandAuthorization(ownerClaim,secret);
  assert.equal(verifyBrowserCommandAuthorization(ownerClaim,secret),true);
  assert.equal(verifyBrowserCommandAuthorization({...ownerClaim,ownerFingerprint:"chat_"+"a".repeat(64)},secret),false,
    "a valid command MAC must not survive a change to the owner destination");
  assert.equal(verifyBrowserCommandAuthorization({...ownerClaim,ownerBindingSha256:"0".repeat(64)},secret),false,
    "a valid command MAC must bind the exact signed approval used for the destination");
});

test("owner provider receipt is bound to the approved owner and original conversation",()=>{
  const ownerClaim:BrowserDocumentClaim={...claim,purpose:"owner_wakeup",
    workerId:"main_agent_owner",turn:2,commandId:"owner-wakeup-239-round-2",
    ownerFingerprint:"chat_"+"e".repeat(64),ownerBindingSha256:"f".repeat(64),
    reportTokenHash:"1".repeat(64),conversationId:"owner-conversation",
  };
  const receipt:BrowserProviderReceiptIdentity={repo:ownerClaim.repo,issue:ownerClaim.issue,
    workerId:ownerClaim.workerId,turn:ownerClaim.turn,commandId:ownerClaim.commandId,
    payloadSha256:ownerClaim.payloadSha256,conversationId:ownerClaim.conversationId!,
    purpose:"owner_wakeup",ownerFingerprint:ownerClaim.ownerFingerprint!,
    ownerBindingSha256:ownerClaim.ownerBindingSha256!,messageId:"provider-owner-user-message"};
  assert.equal(matchBrowserReceiptIdentity(ownerClaim,receipt),true);
  assert.throws(()=>matchBrowserReceiptIdentity(ownerClaim,{...receipt,
    ownerFingerprint:"chat_"+"a".repeat(64)}),/browser provider receipt/i);
  assert.throws(()=>matchBrowserReceiptIdentity(ownerClaim,{...receipt,
    conversationId:"different-owner-chat"}),/browser provider receipt/i);
});
