import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevosToolRegistry, DEVOS_TOOLS } from "../src/mcp-tools/registry.js";
import { SKILL_POLICY_WIDGET_URI, skillPolicyWidget } from "../src/skill-policy-widget.js";
import { readSkillPolicy, policyFingerprint } from "../src/skill-policy.js";

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"devos-skill-mcp-test-"));
  await mkdir(join(root,"config"),{recursive:true});
  for(const name of ["devos-skills.json","devos-skill-policy.json"])
    await cp(join("config",name), join(root,"config",name));
  return root;
}
function content(result:{content:Array<{text:string}>,isError?:boolean,structuredContent?:Record<string,unknown>}) {
  return JSON.parse(result.content[0]!.text) as Record<string,unknown>;
}

test("owner skill preference MCP tools are explicit, read-only/get and mutating/set", () => {
  const get=DEVOS_TOOLS.find(x=>x.name==="devos_skill_policy_get");
  const set=DEVOS_TOOLS.find(x=>x.name==="devos_skill_policy_set");
  assert.ok(get && set);
  assert.equal(get.annotations.readOnlyHint,true);
  assert.equal(set.annotations.readOnlyHint,false);
  assert.equal(get._meta.ui.resourceUri, SKILL_POLICY_WIDGET_URI);
  assert.equal(get._meta["openai/widgetAccessible"],true);
  assert.equal(set._meta["openai/widgetAccessible"],true);
  const html=skillPolicyWidget();
  assert.match(html,/DevOS — навыки/);
  assert.match(html,/devos_skill_policy_get/);
  assert.match(html,/devos_skill_policy_set/);
  assert.match(html,/<form id="settings">/);
  assert.match(html,/required/);
  assert.match(html,/optional/);
  assert.match(html,/off/);
  assert.doesNotMatch(html,/ngrok|chat-access\/approve|ownerSecret|DEVOS_CHAT_ACCESS_PASSWORD/);
});

test("MCP owner chat API gets 17 skills and saves global/project/role/task policies with CAS", async () => {
  const root=await fixture();
  try {
    const registry=new DevosToolRegistry(root);
    assert.equal(registry.has("devos_skill_policy_get"),true);
    assert.equal(registry.has("devos_skill_policy_set"),true);
    assert.equal(registry.list().filter(x=>String(x.name).startsWith("devos_skill_policy_")).length,2);
    const initial=await registry.call("devos_skill_policy_get",{});
    assert.equal(initial.isError,undefined);
    const before=content(initial);
    assert.equal((before.skills as unknown[]).length,17);
    assert.deepEqual(before.policy,{version:1,rules:[]});
    assert.equal(initial.structuredContent?.fingerprint,before.fingerprint);
    const fingerprint=before.fingerprint as string;
    const set=await registry.call("devos_skill_policy_set",{
      skill_id:"superpowers-test-driven-development",
      mode:"required",scope:"role",context:"developer",expected_fingerprint:fingerprint,
    });
    assert.equal(set.isError,undefined);
    assert.equal(content(set).updated,true);
    const current=await readSkillPolicy(root);
    assert.equal(current.rules.length,1);
    assert.equal(current.rules[0]!.scope,"role");
    assert.equal(current.rules[0]!.mode,"required");
    assert.equal(content(set).fingerprint,policyFingerprint(current));
    const stale=await registry.call("devos_skill_policy_set",{
      skill_id:"superpowers-systematic-debugging",mode:"optional",scope:"global",
      expected_fingerprint:fingerprint,
    });
    assert.equal(stale.isError,true);
    assert.match(stale.content[0]!.text,/changed since/);
    assert.equal((await readSkillPolicy(root)).rules.length,1);
    assert.ok((await readFile(join(root,"config","devos-skill-policy.json"),"utf8"))
      .includes("required"));
  } finally {await rm(root,{recursive:true,force:true});}
});

test("MCP skill policy setter rejects malformed args and never invokes worker report handlers", async () => {
  const root=await fixture();
  try {
    const registry=new DevosToolRegistry(root);
    const current=content(await registry.call("devos_skill_policy_get",{}));
    const base={
      skill_id:"superpowers-test-driven-development",mode:"optional",
      scope:"global",expected_fingerprint:current.fingerprint,
    };
    for(const invalid of [
      {...base,extra:"silently run git merge"},
      {...base,mode:"unknown"},
      {...base,skill_id:"not-registered"},
      {...base,scope:"task",context:"../../etc"},
      {...base,scope:"global",context:"developer"},
    ]) {
      const result=await registry.call("devos_skill_policy_set",invalid);
      assert.equal(result.isError,true);
    }
    assert.deepEqual((await readSkillPolicy(root)).rules,[]);
    const badGet=await registry.call("devos_skill_policy_get",{secret:"owner"});
    assert.equal(badGet.isError,true);
  } finally {await rm(root,{recursive:true,force:true});}
});
