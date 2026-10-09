import assert from "node:assert/strict";
import test from "node:test";
import {readFile,stat} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {parseCliArgs} from "../src/cli.js";
import {parseSkillsCliArgs} from "../src/skills-cli.js";
import {DEVOS_TOOLS} from "../src/mcp-tools/registry.js";

const read=(file:string)=>readFile(file,"utf8");
test("README and AGENTS.md define DevOS as system, Runner as one-Issue executor",async()=>{
 const [readme,agents]=await Promise.all([read("README.md"),read("AGENTS.md")]);
 assert.match(readme,/DevOS — вся интеллектуальная система разработки/);
 assert.match(readme,/DevOS Runner.*одной заранее определённой GitHub Issue/);
 assert.doesNotMatch(readme,/DevOS — это намеренно простой локальный оркестратор/);
 assert.match(agents,/DevOS is the whole autonomous software-development system/);
 assert.match(agents,/DevOS Runner.*one-Issue executor/);
 assert.match(agents,/Main Agent directly implements this already-approved migration/);
 assert.match(agents,/No.*runner|Runner/i);
});
test("feature, Bugfix, Assess and rollback instructions preserve real implementation boundaries",async()=>{
 const guide=await read("docs/devos2-user-guide.md");
 for(const original of ["speckit-specify","speckit-plan","speckit-tasks",
   "speckit.bug.assess","speckit.bug.fix","speckit.bug.test",
   "speckit.assess.intake","speckit.assess.decide"])
   assert.ok(guide.includes(original),original);
 assert.match(guide,/required\/optional\/off/);
 assert.match(guide,/52[0-9]\/52[0-9]|520\/520/);
 assert.match(guide,/Production.*release gate/);
 assert.match(guide,/не.*повторно/i);
 assert.match(guide,/Staging.*Cloudflare/);
});
test("documented CLI/MCP tools are actual parser/tool registry commands",()=>{
 const skills=parseCliArgs(["skills","status"]);
 assert.equal(skills.kind,"skills");
 const issue=parseSkillsCliArgs(["issue","EmporioBreak/DevOS","144",
   "developer","developer","execution","implement","superpowers-test-driven-development"]);
 assert.equal(issue.action,"issue");
 assert.equal(parseSkillsCliArgs(["preview","superpowers-test-driven-development",
   "path/to/candidate.json"]).action,"preview");
 assert.equal(parseCliArgs(["run",".devos/workflow.json"]).kind,"run");
 const tools=new Set<string>(DEVOS_TOOLS.map(x=>x.name));
 for(const key of ["devos_skill_policy_get","devos_skill_policy_set",
   "devos_skill_diagnostics","devos_pipeline_status",
   "devos_skill_manifest","devos_skill_read"])assert.ok(tools.has(key),key);
});
test("all relative reference documents from the new user guide resolve in Staging checkout",async()=>{
 const guideFile="docs/devos2-user-guide.md";
 const text=await read(guideFile);
 const links=[...text.matchAll(/\]\(([^)]+\.md)\)/g)].map(x=>x[1]!);
 assert.ok(links.length>=6);
 for(const link of links)assert.ok((await stat(resolve(dirname(guideFile),link))).isFile(),link);
});

test("worker authorization runbook preserves live blocker and fail-closed operator contract",async()=>{
 const guide=await read("docs/devos2-user-guide.md");
 const runbook=await read("docs/worker-authorization-live-runbook.md");
 assert.match(guide,/worker-authorization-live-runbook\.md/);
 for(const invariant of ["qa_report","activeReport","devos_worker_probe",
   "devos_noop","devos_worker_report","worker_proof_pending",
   "GET HTTP 200","401/404","POST","Production","Staging",
   "scripts/staging-public-mcp.smoke.ts","scripts/staging-safe-chaos.smoke.ts"])
   assert.ok(runbook.includes(invariant),invariant);
 assert.match(runbook,/НЕ|не воспроизводить/);
 assert.match(runbook,/не.*пароль владельца/i);
 assert.match(runbook,/preflight.*blocked|вернуть `blocked`/i);
 assert.match(runbook,/не подтверждает завершение E2E/);
});
