import assert from "node:assert/strict";
import test from "node:test";
import {
  assertBrowserDocumentClaim,
  matchBrowserReceiptIdentity,
  type BrowserDocumentClaim,
  type BrowserDocumentObservation,
  type BrowserProviderReceiptIdentity,
} from "../src/browser-command-identity.js";

const claim:BrowserDocumentClaim={
  repo:"EmporioBreak/DevOS",issue:239,workerId:"cos_browser_qa",turn:4,
  commandId:"command-4",runtimeIncarnation:"runtime-original",
  profileOwner:"profile-original",windowLease:"window-239",
  tabLease:"tab-worker-239",documentId:"document-A",navigationEpoch:7,
  conversationId:"chat-a",payloadSha256:"a".repeat(64),
};
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
