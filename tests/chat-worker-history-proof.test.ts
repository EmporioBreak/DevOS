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

const linked = (extra: Record<string, unknown> = {}) => ({
 conversation_id:id,
 mapping:{
  root:{parent:null,message:{id:"root",author:{role:"system"}}},
  previous:{parent:"root",message:user("old-msg")},
  old_tool:{parent:"previous",message:tool("a".repeat(64))},
  active:{parent:"old_tool",message:user("new-msg")},
  analysis:{parent:"active",message:{author:{role:"assistant"},content:{parts:["thinking"]}}},
  issued:{parent:"analysis",message:tool()},
  ...extra,
 },
});
test("parent-linked provider mapping accepts only probe underneath the exact active user turn",()=>{
 const valid=linked();
 assert.equal(exactWorkerHistoryProof(valid,url,"new-msg",uri),nonce);
 assert.equal(exactWorkerHistoryProof(valid,url,"old-msg",uri),"a".repeat(64));
 assert.equal(exactWorkerHistoryProof({...valid,conversation_id:"wrong"},url,"new-msg",uri),null);
 assert.equal(exactWorkerHistoryProof(valid,url,"absent",uri),null);
 assert.equal(exactWorkerHistoryProof({...valid,messages:[]},url,"new-msg",uri),null,
   "contradictory response representations fail closed");
});

test("mapping denies wrong parent, intervening user, cyclic and missing ancestry",()=>{
 const disconnected=linked({issued:{parent:"root",message:tool()}});
 assert.equal(exactWorkerHistoryProof(disconnected,url,"new-msg",uri),null);
 const interposed=linked({
   another:{parent:"analysis",message:user("another-msg")},
   issued:{parent:"another",message:tool()},
 });
 assert.equal(exactWorkerHistoryProof(interposed,url,"new-msg",uri),null);
 const cyclic=linked({
   issued:{parent:"analysis",message:tool()},
   analysis:{parent:"issued",message:{author:{role:"assistant"}}},
 });
 assert.equal(exactWorkerHistoryProof(cyclic,url,"new-msg",uri),null);
 const dangling=linked({issued:{parent:"missing",message:tool()}});
 assert.equal(exactWorkerHistoryProof(dangling,url,"new-msg",uri),null);
});
test("mapping does not trust assistant text, tool arguments or competing probes",()=>{
 const wrongSource=linked({issued:{parent:"analysis",message:{...tool(),author:{role:"assistant"}}}});
 assert.equal(exactWorkerHistoryProof(wrongSource,url,"new-msg",uri),null);
 const wrongResource=linked({issued:{parent:"analysis",message:tool(nonce,"/fake/link/devos_worker_probe")}});
 assert.equal(exactWorkerHistoryProof(wrongResource,url,"new-msg",uri),null);
 const conflict=linked({other:{parent:"active",message:tool("e".repeat(64))}});
 assert.equal(exactWorkerHistoryProof(conflict,url,"new-msg",uri),null);
});

test("mapping uses ancestry regardless of property order and enforces exact conversation identity",()=>{
 const valid=linked();
 const shuffled={...valid,mapping:Object.fromEntries(Object.entries(valid.mapping).reverse())};
 assert.equal(exactWorkerHistoryProof(shuffled,url,"new-msg",uri),nonce);
 const {conversation_id:ignored,...history}=shuffled;
 assert.equal(exactWorkerHistoryProof({...history,id},url,"new-msg",uri),nonce,
   "provider id alias is accepted only when it equals the canonical saved chat");
 assert.equal(exactWorkerHistoryProof({...shuffled,id:"another-chat"},url,"new-msg",uri),null,
   "contradictory IDs fail closed");
});
test("mapping exact-prompt fallback requires a unique submitted user message",()=>{
 const prompt="Dedicated worker test\nunique-token=abcdef12345";
 const exactUser={id:"provider-current",author:{role:"user"},content:{parts:[prompt]}};
 const valid=linked({active:{parent:"old_tool",message:exactUser}});
 assert.equal(exactWorkerHistoryProof(valid,url,undefined,uri,prompt),nonce);
 assert.equal(exactWorkerHistoryProof(valid,url,undefined,uri,prompt+" changed"),null);
 assert.equal(exactWorkerHistoryProof(linked({active:{parent:"old_tool",message:exactUser},
   duplicate:{parent:"old_tool",message:exactUser}}),url,undefined,uri,prompt),null);
});
