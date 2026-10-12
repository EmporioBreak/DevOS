import test from "node:test";
import assert from "node:assert/strict";
import {exactProviderAcceptedUserMessage} from "../src/chat-worker-history-proof.js";

const chat="https://chatgpt.com/c/7330aa93-c7b6-4813-a7f0-4f8ce56507a7";
const id="user-accepted-123",text="Work on the exact E2E\nQA → developer";
const conversationId=chat.split("/c/")[1]!;
const message={id,author:{role:"user"},content:{parts:[text]}};
test("native history GET proves exact accepted user message in provider mapping or array",()=>{
  assert.equal(exactProviderAcceptedUserMessage({conversation_id:conversationId,
    mapping:{"u":{message,parent:null}}},chat,id,text),id);
  assert.equal(exactProviderAcceptedUserMessage({conversation_id:conversationId,
    messages:[message,{id:"assistant",author:{role:"assistant"},content:{parts:["Done"]}}]},chat,id,text),id);
});
test("POST-only identity, foreign chat, wrong content, duplicate or conflicting history cannot prove delivery",()=>{
  const good={conversation_id:conversationId,messages:[message]};
  assert.equal(exactProviderAcceptedUserMessage({messages:[message]},chat,id,text),null);
  assert.equal(exactProviderAcceptedUserMessage(good,
    "https://chatgpt.com/c/7330aa93-c7b6-4813-a7f0-4f8ce56507a8",id,text),null);
  assert.equal(exactProviderAcceptedUserMessage(good,chat,id,text+" changed"),null);
  assert.equal(exactProviderAcceptedUserMessage({conversation_id:conversationId,messages:[message,message]},chat,id,text),null);
  assert.equal(exactProviderAcceptedUserMessage({...good,mapping:{}},chat,id,text),null);
  assert.equal(exactProviderAcceptedUserMessage(good,chat,"other-user",text),null);
  assert.equal(exactProviderAcceptedUserMessage({conversation_id:conversationId,
    messages:[{...message,author:{role:"assistant"}}]},chat,id,text),null);
});
