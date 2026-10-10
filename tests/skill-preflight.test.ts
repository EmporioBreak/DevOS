import assert from "node:assert/strict";
import test from "node:test";
import { readFile, cp, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { preflightSkills, findConflictingSkillDirective,
  type SkillPreflightRequest, type SkillPreflightOptions } from "../src/skill-preflight.js";
import type { SkillLibrary } from "../src/skills-library.js";

const library: SkillLibrary = JSON.parse(await readFile("config/devos-skills.json", "utf8"));
const qualityPolicy = JSON.parse(await readFile("config/devos-quality-methods.json", "utf8"));
const stagePins = JSON.parse(await readFile("config/devos-speckit-stage-pins.json", "utf8"));
const roots = {
  projectRoot: process.cwd(),
  upstreamRoot: join(homedir(), ".devos-staging", "upstream"),
  upstreamPins: { superpowers: "8ca22dba9a94f28898bbce59f2537ff4d87c747d" },
};
const options: SkillPreflightOptions = { library, qualityPolicy, stagePins, roots };
const select = (id: string) => {
  const item = library.skills.find(s => s.id === id);
  assert.ok(item, `unknown skill ${id}`);
  return { id, version: item.version };
};
const planning = (skills: string[], overrides: Partial<SkillPreflightRequest> = {}): SkillPreflightRequest => ({
  phase: "planning",
  role: "main_agent",
  selected: skills.map(select),
  required: [],
  off: [],
  specKitStage: "plan",
  ...overrides,
});
const execution = (skills: string[], overrides: Partial<SkillPreflightRequest> = {}): SkillPreflightRequest => ({
  phase: "execution",
  role: "developer",
  selected: skills.map(select),
  required: [],
  off: [],
  specKitStage: "implement",
  ...overrides,
});

test("Main Agent planning approves pinned adapted skill plus original Spec Kit plan", async () => {
  const before = planning(["devos-writing-plans", "devos-brainstorming"]);
  const result = await preflightSkills(before, options);
  assert.deepEqual(result.skills, before.selected);
  assert.equal(result.stageSkillId, "speckit-plan");
  assert.equal(result.phase, "planning");
  assert.equal(result.role, "main_agent");
  assert.equal(before.selected.length, 2, "preflight cannot create workers or extra skills");
});

test("execution uses unchanged original Superpowers TDD/review with official Spec Kit implement", async () => {
  const request = execution([
    "superpowers-test-driven-development", "superpowers-verification-before-completion",
  ], { required: ["superpowers-test-driven-development"] });
  const r = await preflightSkills(request, options);
  assert.equal(r.stageSkillId, "speckit-implement");
  assert.deepEqual(r.skills, request.selected);
  const noAdditional = await preflightSkills(execution([], {specKitStage:"converge"}), options);
  assert.equal(noAdditional.stageSkillId, "speckit-converge");
});

test("rejects dynamically dispatched workers and competing original orchestration/plan skills", async () => {
  for (const id of qualityPolicy.neverAutoActivate) {
    await assert.rejects(preflightSkills(execution([id]), options), /preflight blocked.*(self-dispatch|graph)/i);
  }
  for (const [id, expected] of [
    ["superpowers-brainstorming","devos-brainstorming"],
    ["superpowers-writing-plans","devos-writing-plans"],
    ["superpowers-using-superpowers","Main Agent"],
  ] as const) {
    await assert.rejects(preflightSkills(planning([id]), options),
      error => error instanceof Error && error.message.includes(expected));
  }
  await assert.rejects(preflightSkills(execution(["devos-writing-plans"]), options),
    /predevelopment-only/);
  await assert.rejects(preflightSkills(planning(["devos-brainstorming"], {role:"developer"}), options),
    /predevelopment-only/);
});

test("missing required, explicitly off and missing dependencies are hard blockers", async () => {
  const tdd = "superpowers-test-driven-development";
  await assert.rejects(preflightSkills(execution([], {required:[tdd]}), options),
    /mandatory skill omitted/);
  await assert.rejects(preflightSkills(execution([tdd], {off:[tdd]}), options),
    /disabled skill was selected/);
  await assert.rejects(preflightSkills(execution([], {required:[tdd],off:[tdd]}), options),
    /required skill is explicitly off/);
  const altered: SkillLibrary = structuredClone(library);
  altered.skills.find(x=>x.id===tdd)!.requires = ["superpowers-verification-before-completion"];
  await assert.rejects(preflightSkills(execution([tdd]), {...options, library:altered}),
    /requires unselected skill/);
  await assert.rejects(preflightSkills(execution([tdd], {off:["superpowers-verification-before-completion"]}),
    {...options, library:altered}), /requires disabled skill/);
});

test("conflicts work in either direction; unknown IDs, duplicate pins and version drift fail closed", async () => {
  const tdd = "superpowers-test-driven-development", verify="superpowers-verification-before-completion";
  const both = execution([tdd,verify]);
  const conflicted: SkillLibrary = structuredClone(library);
  conflicted.skills.find(x=>x.id===verify)!.conflicts = [tdd];
  await assert.rejects(preflightSkills(both, {...options, library:conflicted}), /conflicting skills/);
  const otherWay: SkillLibrary = structuredClone(library);
  otherWay.skills.find(x=>x.id===tdd)!.conflicts = [verify];
  await assert.rejects(preflightSkills(both, {...options, library:otherWay}), /conflicting skills/);
  await assert.rejects(preflightSkills(execution([tdd], {
    selected:[{id:tdd,version:"0.0.1"}],
  }), options), /version mismatch/);
  await assert.rejects(preflightSkills(execution([tdd], {
    selected:[select(tdd),select(tdd)],
  }), options), /duplicate selected/);
  await assert.rejects(preflightSkills(execution([tdd], {
    selected:[{id:"unregistered-evil",version:"1.0.0"}],
  }), options), /not in reviewed registry/);
  await assert.rejects(preflightSkills(execution([tdd], {required:["not-installed"]}), options),
    /mandatory skill omitted/);
});

test("mandatory official Spec Kit stage is hashed, cannot be substituted, and wrong phase fails", async () => {
  const unbound: any = planning([]); delete unbound.specKitStage;
  await assert.rejects(preflightSkills(unbound, options), /stage must be explicit/);
  await assert.rejects(preflightSkills(execution([], {specKitStage:null}), options),
    /mandatory Spec Kit stage cannot be skipped/);
  await assert.rejects(preflightSkills(planning([], {specKitStage:"implement"}), options),
    /stage not valid/);
  await assert.rejects(preflightSkills(execution([], {specKitStage:"plan"}), options),
    /stage not valid/);
  await assert.rejects(preflightSkills(planning([], {specKitStage:"workflow-engine"}), options),
    /original Spec Kit stage/);
  const wrongPins = structuredClone(stagePins);
  wrongPins.stages.plan.sha256 = "f".repeat(64);
  await assert.rejects(preflightSkills(planning([]), {...options, stagePins:wrongPins}),
    /original Spec Kit stage.*cannot be omitted/);
  const missing = structuredClone(stagePins);
  delete missing.stages.plan;
  await assert.rejects(preflightSkills(planning([]), {...options, stagePins:missing}),
    /original Spec Kit stage.*cannot be omitted/);
  const root = await mkdtemp(join(tmpdir(),"devos-spec-stage-"));
  try {
    await mkdir(join(root,".agents","skills","speckit-plan"),{recursive:true});
    await cp(".agents/skills/speckit-plan/SKILL.md",
      join(root,".agents","skills","speckit-plan","SKILL.md"));
    await preflightSkills(planning([]), {...options, roots:{...roots,projectRoot:root}});
    await writeFile(join(root,".agents","skills","speckit-plan","SKILL.md"),
      "unreviewed stage rewrite");
    await assert.rejects(preflightSkills(planning([]), {...options, roots:{...roots,projectRoot:root}}),
      /original Spec Kit stage.*cannot be omitted/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("selected skill source hash drift fails with actionable diagnostic", async () => {
  const temp = await mkdtemp(join(tmpdir(),"devos-preflight-drift-"));
  try {
    await mkdir(join(temp,"skills"),{recursive:true});
    await mkdir(join(temp,".agents","skills","speckit-plan"),{recursive:true});
    await cp(".agents/skills/speckit-plan/SKILL.md",
      join(temp,".agents","skills","speckit-plan","SKILL.md"));
    await cp("skills/devos-writing-plans", join(temp,"skills","devos-writing-plans"),{recursive:true});
    const request = planning(["devos-writing-plans"]);
    // planning request must have a canonical Spec Kit stage even in an isolated fixture
    request.specKitStage = "plan";
    await preflightSkills(request, {...options,roots:{...roots, projectRoot:temp}});
    await writeFile(join(temp,"skills","devos-writing-plans","SKILL.md"),"modified");
    await assert.rejects(preflightSkills(request,
      {...options,roots:{...roots,projectRoot:temp}}), /pinned file integrity/);
  } finally {await rm(temp,{recursive:true,force:true});}
});


test("unreviewed custom directives to launch subagents or take Git ownership are blocked", async () => {
  for (const directive of [
    "Launch new subagent to implement the task",
    "Dispatch an independent agent to review all changes",
    "git checkout -b superpowers/test",
    "git merge arbitrary-branch",
    "Use superpowers:subagent-driven-development",
    "Run speckit workflow run independently",
  ]) assert.ok(findConflictingSkillDirective("# Custom\n" + directive),
    "unsafe explicit instruction was accepted: " + directive);
  for (const safe of [
    "Never launch new subagent.",
    "Do not run git checkout in a worker.",
    "Use original Spec Kit tasks.md without a second plan.",
    "Report a blocker if a new independent review is requested.",
  ]) assert.equal(findConflictingSkillDirective(safe), null);
  const temp = await mkdtemp(join(tmpdir(), "devos-custom-directive-"));
  try {
    const localDir = join(temp, "skills", "untrusted-extension");
    await mkdir(localDir, {recursive:true});
    await writeFile(join(localDir, "SKILL.md"), "# Self dispatch\nLaunch new subagent to implement this task\n");
    const { snapshotSkillDirectory } = await import("../src/skills-library.js");
    const custom = {
      ...structuredClone(library.skills.find(x=>x.id==="devos-writing-plans")!),
      id: "untrusted-extension",
      source: { kind:"local" as const, directory:"skills/untrusted-extension",
        license:"MIT", sourceUrl:"https://github.com/EmporioBreak/DevOS" },
      files: await snapshotSkillDirectory(localDir),
      conflicts: [],
    };
    const localLibrary: SkillLibrary = {
      version:1, skills: [...library.skills,custom],
    };
    const input = planning([],{specKitStage:null,
      selected:[{id:custom.id,version:custom.version}]});
    await assert.rejects(preflightSkills(input,{
      ...options,library:localLibrary,roots:{...roots,projectRoot:temp},
    }), /competing execution instructions/);
  } finally {await rm(temp,{recursive:true,force:true});}
});
