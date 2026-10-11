import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {JsonStateStore} from "../src/json-state-store.js";
import {assertBrowserCommandMatchesReport,assertCurrentBrowserTurn} from "../src/browser-command-authority.js";

test("native browser authorization requires the exact unexpired persisted active turn",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-active-browser-grant-"));
  const task={repo:"owner/repo",issue:239,pr:240};
  const expiresAt=Date.now()+60_000;
  const command={task,workerId:"developer",turn:3,tokenHash:"a".repeat(64),
    graphSha256:"b".repeat(64),workerManifestSha256:"c".repeat(64),expiresAt};
  const store=new JsonStateStore(root,task);
  try{
    await store.save({task,currentWorkerId:"developer",completedRuns:3,reviewLoops:1,
      sessions:{developer:"https://chatgpt.com/c/exact-worker-chat"},
      activeReport:{workerId:"developer",turn:3,tokenHash:command.tokenHash,expiresAt}});
    await assertCurrentBrowserTurn(root,command);
    await assert.rejects(assertCurrentBrowserTurn(root,{...command,tokenHash:"d".repeat(64)}),/active persisted worker grant/);
    await assert.rejects(assertCurrentBrowserTurn(root,{...command,task:{...task,pr:241}}),/active persisted worker grant/);
    await assert.rejects(assertCurrentBrowserTurn(root,{...command,expiresAt:Date.now()-1}),/expired/);
    await store.save({task,currentWorkerId:"reviewer",completedRuns:4,reviewLoops:1,
      sessions:{developer:"https://chatgpt.com/c/exact-worker-chat"},
      activeReport:{workerId:"reviewer",turn:4,tokenHash:"e".repeat(64),expiresAt}});
    await assert.rejects(assertCurrentBrowserTurn(root,command),/active persisted worker grant/,
      "a valid old command MAC cannot survive replacement of the active task turn");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("well-formed but mismatched report token cannot authorize a command",()=>{
  const task={repo:"owner/repo",issue:239,pr:240};
  const report={task,active:{workerId:"developer",turn:3,tokenHash:"a".repeat(64),expiresAt:99_999}};
  const command={task,workerId:"developer",turn:3,reportTokenHash:"b".repeat(64),
    graphSha256:"c".repeat(64),workerManifestSha256:"d".repeat(64),expiresAt:99_999};
  assert.throws(()=>assertBrowserCommandMatchesReport(command,report),/active trusted worker report/);
  assert.throws(()=>assertBrowserCommandMatchesReport({...command,reportTokenHash:report.active.tokenHash,
    task:{...task,pr:241}},report),/active trusted worker report/);
  assert.doesNotThrow(()=>assertBrowserCommandMatchesReport({...command,
    reportTokenHash:report.active.tokenHash},report));
});
