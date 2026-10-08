import assert from "node:assert/strict";
import test from "node:test";
import { exactWorkerHistoryProof } from "../src/chat-worker-history-proof.js";
const url="https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/c/6ac7d917-1390-83ed-95a7-e6309a53e812";
const id="6ac7d917-1390-83ed-95a7-e6309a53e812";
const uri="/asdk_app_production/link_production/devos_worker_probe";
const nonce="f".repeat(64);
const tool=(challenge=nonce, resource=uri)=>({id:"tool-1",author:{role:"tool",name:"api_tool.call_tool"},
status:"finished_successfully",metadata:{invoked_resource:{resource_uri:resource}},
content:{content_type:"code",text:JSON.stringify({result:{structuredContent:{status:"issued",nonce:challenge}}})}});
const user=(name:string)=>({id:name,author:{role:"user"},content:{content_type:"text",parts:["not trusted"]}});
const conversation=(messages:any[])=>({conversation_id:id,messages});
test("exact saved conversation and exact submitted user message precede provider proof",()=>{
 const valid=conversation([user("old-msg"),tool("a".repeat(64)),user("new-msg"),tool()]);
 assert.equal(exactWorkerHistoryProof(valid,url,"new-msg",uri),nonce);
 assert.equal(exactWorkerHistoryProof(valid,url,"old-msg",uri),"a".repeat(64),"each user turn owns only its own proof");
 assert.equal(exactWorkerHistoryProof(valid,url,"fake-msg",uri),null);
 assert.equal(exactWorkerHistoryProof({...valid,conversation_id:"other"},url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(valid,url+"/", "new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(valid,url,"new-msg","/malicious/link/devos_worker_probe"),null);
});
test("exact local submitted prompt identifies one user turn when provider user-message ID is absent",()=>{
 const prompt="Implement scoped worker task. Never share tokens.\nturn_token="+"d".repeat(64);
 const fromPrompt=(text:string)=>({id:"provider-user",author:{role:"user"},
   content:{content_type:"text",parts:[text]}});
 const valid=conversation([user("old-msg"),tool("a".repeat(64)),fromPrompt(prompt),tool()]);
 assert.equal(exactWorkerHistoryProof(valid,url,undefined,uri,prompt),nonce);
 assert.equal(exactWorkerHistoryProof(valid,url,undefined,uri,prompt.replace("\n","\r\n")),nonce,
   "equivalent line endings must not prevent exact provider matching");
 assert.equal(exactWorkerHistoryProof(valid,url,undefined,uri,prompt+" tampered"),null);
 assert.equal(exactWorkerHistoryProof(conversation([fromPrompt(prompt),tool(),fromPrompt(prompt)]),url,undefined,uri,prompt),null,
   "ambiguous duplicate user prompts must not authenticate");
 assert.equal(exactWorkerHistoryProof(conversation([tool(),fromPrompt(prompt)]),url,undefined,uri,prompt),null,
   "previous turn tool proof must not be attributed to this turn");
 assert.equal(exactWorkerHistoryProof(valid,url,undefined,uri),null,"no user ID and no prompt means fail closed");
});

test("history refuses model text, prior-turn evidence and ambiguous tool results",()=>{
 const good=tool();
 const fakeAssistant={author:{role:"assistant"},content:{content_type:"text",parts:[nonce]}};
 assert.equal(exactWorkerHistoryProof(conversation([tool(),user("new-msg"),fakeAssistant]),url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(conversation([user("new-msg"),user("next-msg"),good]),url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(conversation([user("new-msg"),good,tool("e".repeat(64))]),url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(conversation([user("new-msg"),good,good]),url,"new-msg",uri),nonce);
 assert.equal(exactWorkerHistoryProof(conversation([user("new-msg"),tool(nonce,"/fake/link/devos_worker_probe")]),url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(conversation([user("new-msg"),{...good,author:{role:"tool",name:"functions.exec"}}]),url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(conversation([user("new-msg"),good,user("new-msg")]),url,"new-msg",uri),null);
});
