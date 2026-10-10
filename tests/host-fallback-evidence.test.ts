import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {recordHostBackendUnavailable,verifyHostBackendUnavailable} from "../src/host-fallback-evidence.js";
const secret="secure-owner-signed-fallback-fixture-".repeat(3);
const base={repo:"EmporioBreak/DevOS",issue:228,workerId:"browser",turn:1};
const session="https://chatgpt.com/c/expected-private-conversation";
const tokenHash="1".repeat(64);
test("only MACed same-turn host backend outage is valid fallback proof",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-host-proof-"));
  try{
    await recordHostBackendUnavailable(root,secret,base,session,tokenHash,"read_file");
    assert.equal(await verifyHostBackendUnavailable(root,secret,{...base,sessionId:session,tokenHash}),true);
    assert.equal(await verifyHostBackendUnavailable(root,secret,{...base,workerId:"reviewer",sessionId:session,tokenHash}),false);
    assert.equal(await verifyHostBackendUnavailable(root,secret,{...base,issue:229,sessionId:session,tokenHash}),false);
    assert.equal(await verifyHostBackendUnavailable(root,secret,{...base,sessionId:"https://chatgpt.com/c/other",tokenHash}),false);
    assert.equal(await verifyHostBackendUnavailable(root,secret,{...base,sessionId:session,tokenHash:"2".repeat(64)}),false);
    assert.equal(await verifyHostBackendUnavailable(root,"wrong-owner-secret-".repeat(4),{...base,sessionId:session,tokenHash}),false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("tampered or stale host outage receipts cannot authorize fallback",async()=>{
  const root=await mkdtemp(join(tmpdir(),"devos-host-proof-tamper-"));
  try{
    await recordHostBackendUnavailable(root,secret,base,session,tokenHash,"start_process");
    const expected={...base,sessionId:session,tokenHash};
    assert.equal(await verifyHostBackendUnavailable(root,secret,expected,Date.now()+3*60*60_000),false);
    const path=join(root,".devos","host-fallback-proofs",encodeURIComponent(base.repo),
      String(base.issue),`${base.workerId}-${base.turn}.json`);
    const record=JSON.parse(await readFile(path,"utf8"));
    record.proof.tool="read_file";
    await writeFile(path,JSON.stringify(record)+"\n",{mode:0o600});
    assert.equal(await verifyHostBackendUnavailable(root,secret,expected),false);
  }finally{await rm(root,{recursive:true,force:true})}
});
