import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { BrowserCommandBroker } from "../src/browser-command-broker.js";
import { assertOwnerWakeupSurface, ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { signBrowserCommandAuthorization } from "../src/browser-command-identity.js";
import { reportTokenHash } from "../src/mcp-tools/registry.js";
import { OwnerWakeupLedger } from "../src/owner-wakeup-ledger.js";
import { ChatAccessRegistry } from "../src/chat-access.js";
import { OwnerTaskApprovalStore } from "../src/owner-task-approval.js";
import { buildOwnerHandoffMessage } from "../src/owner-wakeup-handoff.js";
import {assertCurrentBrowserTurn} from "../src/browser-command-authority.js";
import {JsonStateStore} from "../src/json-state-store.js";

test("owner wake-up sends one real user-role message through the shared broker and confirms its provider receipt",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-send-"));
  const secret="owner-send-test-secret-"+"x".repeat(48),password="owner-send-password";
  const task={repo:"EmporioBreak/DevOS",issue:239,pr:240};
  const review={repo:task.repo,issue:task.issue,pr:task.pr,gitSha:"e".repeat(40),
    constitutionSha:"a".repeat(64),approvals:[{kind:"constitution" as const,digest:"a".repeat(64)},
      {kind:"scope" as const,digest:"b".repeat(64)}]};
  const targetUrl="https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0";
  const message=buildOwnerHandoffMessage(task,0);
  const chats=new ChatAccessRegistry(root,secret);
  const fingerprint=chats.fingerprint("owner-client","owner-session");
  chats.approve(fingerprint,targetUrl);
  const approvals=new OwnerTaskApprovalStore(root,secret,chats,password);
  const ticket=approvals.issue(fingerprint,review).ticket!;
  assert.equal(approvals.submit({ticket,password,confirm:"approve"}),true);
  const binding=approvals.resolveOwnerChatForTask(task)!;
  const ledger=new OwnerWakeupLedger(root,secret);
  await ledger.enqueue(task,0,fingerprint,targetUrl,message);
  await writeFile(join(root,".env"),`DEVOS_CONNECTOR_OWNER_SECRET=${secret}\n`,{mode:0o600});

  const listeners=new Map<string,Array<(value:any)=>void>>();
  const marker=`devos-task-window:${createHash("sha256").update(`${task.repo}#${task.issue}`).digest("hex")}`;
  let ownerUrl="about:blank",windowName=marker,draft="",sends=0;
  const promptRequest={url:()=>"https://chatgpt.com/backend-api/conversation",method:()=>"POST",
    postDataJSON:()=>({conversation_id:"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",
      messages:[{id:"owner-provider-message-0",author:{role:"user"},content:{parts:[message]}}]})};
  const response={request:()=>promptRequest,status:()=>200,url:()=>promptRequest.url()};
  const emit=(event:string,value:unknown)=>{for(const callback of listeners.get(event)??[])callback(value)};
  let fakeContext:any;
  const makePage=(isOwner:boolean):Page=>{
    const pageUrl=()=>isOwner?ownerUrl:"about:blank";
    const locator={first(){return this},async waitFor(){},async fill(value:string){draft=value},
      async isVisible(){return true},async isEnabled(){return true},
      async click(){sends++;emit("request",promptRequest);emit("response",response)},
      async press(){throw new Error("owner wake-up must click the visible Send button")}};
    return {
      on(event:string,callback:(value:any)=>void){listeners.set(event,[...(listeners.get(event)??[]),callback])},
      off(event:string,callback:(value:any)=>void){listeners.set(event,(listeners.get(event)??[]).filter(x=>x!==callback))},
      mainFrame:()=>({}),url:pageUrl,async goto(url:string){if(isOwner)ownerUrl=url;return {status:()=>200}},
      locator:()=>locator,async evaluate(fn:Function){const source=fn.toString();
        if(source.includes("window.name = value")){windowName=marker;return undefined}
        if(source.includes("window.name"))return windowName;
        if(source.includes("__DEVOS_OWNER_WAKEUP_SURFACE__"))return {marker:"__DEVOS_OWNER_WAKEUP_SURFACE__",href:ownerUrl,conversationId:"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",
          composerVisible:true,composerText:draft,sendEnabled:true,stopVisible:false,loginVisible:false,challengeVisible:false};
        return undefined},async close(){},async bringToFront(){},isClosed:()=>false,
      context:()=>fakeContext,
    } as unknown as Page;
  };
  const rootPage=makePage(false),ownerPage=makePage(true);
  fakeContext={pages(){return [rootPage,ownerPage]},async waitForEvent(){return ownerPage},async close(){},on(){}};
  const executor=new ChatGptBrowserExecutor({projectUrl:"https://chatgpt.com/g/project/project",
    profileDir:join(root,"profile"),headless:true},1000,undefined,undefined,undefined,new BrowserCommandBroker(root,secret),root);
  Object.assign(executor,{context:fakeContext,
    taskWindowPages:new Map([[`${task.repo}#${task.issue}`,rootPage]])});
  try{
    const status=await (executor as any).sendOwnerWakeup({projectRoot:root,task,reviewRound:0,
      ownerFingerprint:binding.fingerprint,approvedReference:binding.approvedReference,
      ownerKind:binding.kind,message});
    assert.equal(status,"confirmed");
    assert.equal(sends,1);
    assert.equal(await ledger.status(task,0),"confirmed");
    const files=(await import("node:fs/promises")).readdir;
    const {readdir:readDir,readFile:read}=await import("node:fs/promises");
    const outbox=join(root,".devos","browser-runtime","command-outbox");
    const record=JSON.parse(await read(join(outbox,(await readDir(outbox)).find(x=>x.endsWith(".json")&&x!=="signing.key")!),"utf8"));
    assert.equal(record.record.status,"acknowledged");
    assert.equal(record.record.command.purpose,"owner_wakeup");
    assert.equal(record.record.command.ownerFingerprint,fingerprint);
    assert.equal(record.record.receipt.messageId,"owner-provider-message-0");
    assert.equal(record.record.receipt.conversationId,"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
    assert.match(windowName,new RegExp(marker));
    void files;
  }finally{await rm(root,{recursive:true,force:true})}
});

test("owner wake-up refuses a share label before touching the existing browser context",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-owner-share-"));
  const executor=new ChatGptBrowserExecutor({
    projectUrl:"https://chatgpt.com/g/project/project",profileDir:join(root,"profile"),headless:true,
  },1000,undefined,undefined,undefined,new BrowserCommandBroker(root),root);
  let navigations=0,sends=0;
  try{
    await assert.rejects((executor as any).sendOwnerWakeup({
      projectRoot:root,task:{repo:"EmporioBreak/DevOS",issue:239,pr:240},reviewRound:0,
      ownerFingerprint:"chat_"+"e".repeat(64),
      approvedReference:"https://chatgpt.com/share/7bc799bd-7ffc-83eb-b2b0-15d6a2f558a0",
      ownerKind:"share_label",message:"review notification",
    }),/verified private/i);
    assert.equal(navigations,0);
    assert.equal(sends,0);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("owner notification requires an idle composer with no pre-existing owner draft",async()=>{
  const url="https://chatgpt.com/c/6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0";
  const base={marker:"__DEVOS_OWNER_WAKEUP_SURFACE__",href:url,
    conversationId:"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0",composerVisible:true,
    composerText:"",sendEnabled:false,stopVisible:false,loginVisible:false,challengeVisible:false};
  const page={async evaluate(){return base}} as unknown as Page;
  await assertOwnerWakeupSurface(page,url,"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0");
  await assert.rejects(assertOwnerWakeupSurface({...page,evaluate:async()=>({...base,composerText:"owner draft"})} as Page,
    url,"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0"),/existing draft/i);
  await assert.rejects(assertOwnerWakeupSurface({...page,evaluate:async()=>({...base,stopVisible:true})} as Page,
    url,"6ac799bd-7ffc-83eb-b2b0-15d6a2f558a0"),/busy/i);
});

test("browser executor refuses a native Send without the active trusted report turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-executor-"));
  const projectUrl = "https://chatgpt.com/g/project/project";
  const conversationUrl = "https://chatgpt.com/g/project/c/conversation-1";
  const commandId = "cmd-239-worker-turn-1";
  const broker = new BrowserCommandBroker(root);
  const listeners = new Map<string, Array<(value: any) => void>>();
  let url = projectUrl;
  let sends = 0;
  let claimStatusAtSend: string | undefined;
  const prompt = "Run the approved worker task";
  const outgoing = {
    url: () => "https://chatgpt.com/backend-api/conversation",
    method: () => "POST",
    postDataJSON: () => ({
      conversation_id: "conversation-1",
      messages: [{ id: "user-message-1", author: { role: "user" }, content: { parts: [prompt] } }],
    }),
  };
  const response = { request: () => outgoing, status: () => 200, url: () => outgoing.url() };
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const locator = {
    first() { return this; },
    async waitFor() {},
    async fill() {},
    async isVisible() { return true; },
    async click() {
      sends++;
      url = conversationUrl;
      emit("request", outgoing);
      emit("response", response);
    },
    async press() { throw new Error("fixture expects the visible Send button"); },
  };
  const frame = {};
  const page = {
    on(event: string, listener: (value: any) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off(event: string, listener: (value: any) => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter(existing => existing !== listener));
    },
    mainFrame: () => frame,
    url: () => url,
    async goto() { url = projectUrl; return { status: () => 200 }; },
    locator: () => locator,
    async evaluate(fn: Function) {
      return fn.toString().includes("__DEVOS_ARM_STREAM__") ? 1 : { text: "done", failed: false };
    },
    async waitForFunction() {},
    async close() {},
    isClosed: () => false,
  } as unknown as Page;
  const executor = new ChatGptBrowserExecutor(
    { projectUrl, profileDir: join(root, "profile"), headless: true }, 1000,
    undefined, undefined, undefined, broker,
  );
  Object.assign(executor, { context: {
    async newPage() { return page; },
    pages() { return [page]; },
    async addInitScript() {},
    async close() {},
    on() {},
  } });
  try {
    await assert.rejects(executor.run({
      projectRoot: root, prompt, workerId: "developer", browserTurnId: commandId,
      reportTurn: { task: { repo: "EmporioBreak/DevOS", issue: 239, pr: 241 }, active: { workerId: "developer", turn: 1, tokenHash: "a".repeat(64) } },
      browserCommand: {
        task: { repo: "EmporioBreak/DevOS", issue: 239, pr: 240 },
        workerId: "developer", turn: 1, commandId, reportTokenHash: "a".repeat(64),
        graphSha256: "b".repeat(64), workerManifestSha256: "c".repeat(64), authorizationMac: "d".repeat(64),
      },
    } as any), /Trusted browser command identity/);
    assert.equal(sends, 0, "missing trusted report turn must be rejected before native Send");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser executor claims the signed Issue window before Send and ACKs the exact provider receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-command-executor-green-"));
  const ownerSecret = "test-owner-secret-that-is-at-least-thirty-two-bytes";
  const task = { repo: "EmporioBreak/DevOS", issue: 239, pr: 240 };
  const token = "a".repeat(64), tokenHash = reportTokenHash(token);
  const expiresAt=Date.now()+60_000;
  const commandId = `239:0:developer:${tokenHash}`;
  const graphSha256 = "b".repeat(64), workerManifestSha256 = "c".repeat(64);
  const authorization = { repo: task.repo, issue: task.issue, pr: task.pr, workerId: "developer", turn: 0,
    commandId, reportTokenHash: tokenHash, graphSha256, workerManifestSha256,expiresAt,conversationId:undefined,
  };
  const broker = new BrowserCommandBroker(root, ownerSecret);
  const listeners = new Map<string, Array<(value: any) => void>>();
  const projectUrl = "https://chatgpt.com/g/project/project";
  const conversationUrl = "https://chatgpt.com/g/project/c/conversation-1";
  const prompt = "Run the approved worker task";
  let url = projectUrl, sends = 0, statusAtSend: string | undefined;
  const outgoing = { url: () => "https://chatgpt.com/backend-api/conversation", method: () => "POST",
    postDataJSON: () => ({ conversation_id: "conversation-1", messages: [{ id: "user-message-1", author: { role: "user" }, content: { parts: [prompt] } }] }) };
  const response = { request: () => outgoing, status: () => 200, url: () => outgoing.url() };
  const emit = (event: string, value: unknown) => { for (const listener of listeners.get(event) ?? []) listener(value); };
  const locator = { first() { return this; }, async waitFor() {}, async fill() {}, async isVisible() { return true; },
    async click() { statusAtSend = (await broker.get(commandId))?.status; sends++; url = conversationUrl; emit("request", outgoing); emit("response", response); },
    async press() { throw new Error("fixture expects the visible Send button"); } };
  const marker = `devos-task-window:${createHash("sha256").update(`${task.repo}#${task.issue}`).digest("hex")}`;
  const frame = {};
  const page = { on(event: string, listener: (value: any) => void) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    off(event: string, listener: (value: any) => void) { listeners.set(event, (listeners.get(event) ?? []).filter(x => x !== listener)); },
    mainFrame: () => frame, url: () => url, async goto() { url = projectUrl; return { status: () => 200 }; }, locator: () => locator,
    async evaluate(fn: Function) { const source=fn.toString(); if(source.includes("window.name")) return marker; return source.includes("__DEVOS_ARM_STREAM__") ? 1 : { text: "done", failed: false }; },
    async waitForFunction() {}, async close() {}, isClosed: () => false } as unknown as Page;
  const executor = new ChatGptBrowserExecutor({ projectUrl, profileDir: join(root, "profile"), headless: true }, 1000,
    undefined, undefined, undefined, broker,root,async()=>assertCurrentBrowserTurn(root,{
      task,workerId:"developer",turn:0,tokenHash,graphSha256,workerManifestSha256,expiresAt,
    }));
  Object.assign(executor, { context: { async newPage() { return page; }, pages() { return [page]; }, async addInitScript() {}, async close() {}, on() {} },
    workerPages: new Map([[`${task.repo}#${task.issue}\0developer`, page]]), taskWindowPages: new Map([[`${task.repo}#${task.issue}`, page]]) });
  const active = { workerId: "developer", turn: 0, tokenHash,expiresAt };
  const reportPath = join(root, ".devos", "worker-reports", `${encodeURIComponent(task.repo)}-issue-${task.issue}`, `turn-0-${tokenHash}.json`);
  await mkdir(join(root, ".devos", "worker-reports", `${encodeURIComponent(task.repo)}-issue-${task.issue}`), { recursive: true });
  await writeFile(join(root,".env"),`DEVOS_CONNECTOR_OWNER_SECRET=${ownerSecret}\n`,{mode:0o600});
  await new JsonStateStore(root,task).save({task,currentWorkerId:"developer",completedRuns:0,
    sessions:{developer:conversationUrl},activeReport:{workerId:"developer",turn:0,tokenHash,expiresAt}});
  await writeFile(reportPath, JSON.stringify({ task: { repo: task.repo, issue: task.issue }, worker_id: "developer", turn: 0,
    token_hash: tokenHash, status: "done", summary: "fixture report" }));
  try {
    const result = await executor.run({ projectRoot: root, task, prompt, workerId: "developer", browserTurnId: commandId,
      reportTurn: { task, active }, browserCommand: { task, workerId: "developer", turn: 0, commandId, reportTokenHash: tokenHash,
        expiresAt,
        graphSha256, workerManifestSha256, authorizationMac: signBrowserCommandAuthorization(authorization, ownerSecret) } } as any);
    assert.equal(result.sessionId, conversationUrl);
    assert.equal(sends, 1);
    assert.equal(statusAtSend, "claimed", "the durable single-project window claim must precede native Send");
    const record = await broker.get(commandId);
    assert.equal(record?.status, "acknowledged");
    assert.equal(record?.receipt?.messageId, "user-message-1");
    assert.equal(record?.command.graphSha256, graphSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
