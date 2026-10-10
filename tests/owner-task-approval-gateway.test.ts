import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdtemp,rm,symlink,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {Transport} from "@modelcontextprotocol/sdk/shared/transport.js";
import {startGateway} from "../src/connector-gateway.js";
import {oauthToken} from "./connector-auth-fixture.js";
import {OwnerTaskApprovalStore,trustedTaskApprovalVerifier} from "../src/owner-task-approval.js";
import {ChatAccessRegistry} from "../src/chat-access.js";

const secret="unit-secret-"+randomBytes(32).toString("hex");
const password="test-only-"+randomBytes(32).toString("hex");
const chatUrl="https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0";
const review=()=>({repo:"EmporioBreak/DevOS",issue:214,pr:215,
  gitSha:"a".repeat(40),constitutionSha:"b".repeat(64),
  approvals:[{kind:"constitution",digest:"b".repeat(64)},
    {kind:"scope",digest:"c".repeat(64)},
    {kind:"plan",digest:"d".repeat(64)}]});
const output=(r:any)=>r.structuredContent||JSON.parse(r.content[0].text);
test("MCP exact owner approval only from approved host session",
  {timeout:80000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos216-gateway-"));
  const issuer="https://approval-test.devos.example";
  await symlink(join(process.cwd(),"node_modules"),join(root,"node_modules"),"dir");
  await writeFile(join(root,".env"),"DEVOS_CHAT_ACCESS_PASSWORD="+password+"\n",{mode:0o600});  const gateway=await startGateway({root,port:0,ownerSecret:secret,
    publicUrl:issuer,oauthClientsPath:null});
  const base="http://127.0.0.1:"+gateway.address.port;
  const first=new Client({name:"test-owner",version:"1"},{capabilities:{}});
  const second=new Client({name:"test-other",version:"1"},{capabilities:{}});
  try{
    const {tokens,client:oauth}=await oauthToken(base,secret,issuer+"/mcp");
    const connect=(c:Client,session:string)=>c.connect(new StreamableHTTPClientTransport(
      new URL(base+"/mcp"),{requestInit:{headers:{
        Authorization:"Bearer "+tokens.access_token,"x-openai-session":session}}}) as Transport);
    await connect(first,"qa-owner-chat");
    await connect(second,"qa-other-chat");
    const call=(c:Client,name:string,args:Record<string,unknown>)=>
      c.callTool({name,arguments:args});
    const listed=(await first.listTools()).tools;
    assert.ok(listed.some(x=>x.name==="devos_owner_approval_request"));
    assert.ok(listed.some(x=>x.name==="devos_owner_approval_status"));
    assert.deepEqual(output(await call(second,"devos_owner_approval_request",review())),
      {ready:false,reason:"owner_chat_required"});
    const registry=new ChatAccessRegistry(root,secret);
    registry.approve(registry.fingerprint(oauth.client_id,"qa-owner-chat"),chatUrl);
    const issued=output(await call(first,"devos_owner_approval_request",review()));
    assert.equal(issued.ready,true);
    assert.match(issued.approval_url,/^https:\/\/approval-test.devos.example\/owner-approval\/form#/);
    const html=await fetch(base+"/owner-approval/form");
    assert.equal(html.status,200);
    assert.match(await html.text(),/Утверждаю точно указанные версии/);
    const send=(path:string,body:unknown,origin?:string)=>fetch(base+path,{method:"POST",
      headers:{"Content-Type":"application/json",...(origin?{Origin:origin}:{})},
      body:JSON.stringify(body)});    assert.equal((await send("/owner-approval/preview",{ticket:issued.ticket},
      "https://other.example")).status,403);
    const preview=await send("/owner-approval/preview",{ticket:issued.ticket});
    assert.equal(preview.status,200);
    assert.deepEqual(await preview.json(),review());
    assert.deepEqual(output(await call(first,"devos_owner_approval_status",
      {ticket:issued.ticket})),{approved:false});
    assert.equal((await send("/owner-approval/submit",{ticket:issued.ticket,
      confirm:"approve",password:"wrong"})).status,403);
    assert.equal((await send("/owner-approval/submit",{ticket:issued.ticket,
      confirm:"approve",password})).status,200);
    assert.equal((await send("/owner-approval/submit",{ticket:issued.ticket,
      confirm:"approve",password})).status,403);
    const ref=output(await call(first,"devos_owner_approval_status",
      {ticket:issued.ticket})).approval_ref as string;
    assert.match(ref,/^devos-owner-approval:/);
    assert.deepEqual(output(await call(second,"devos_owner_approval_status",
      {ticket:issued.ticket})),{ready:false,reason:"owner_chat_required"});
    const store=new OwnerTaskApprovalStore(root,secret,registry,password);
    const verify=trustedTaskApprovalVerifier(store,review());
    assert.equal(await verify({userMessageRef:ref,kind:"plan",
      reviewedDigest:"d".repeat(64)},{kind:"plan",digest:"d".repeat(64)}),true);
    assert.equal(await verify({userMessageRef:ref,kind:"plan",
      reviewedDigest:"e".repeat(64)},{kind:"plan",digest:"e".repeat(64)}),false);
  }finally{
    await Promise.allSettled([first.close(),second.close()]);
    await gateway.close();
    await rm(root,{recursive:true,force:true});
  }
});