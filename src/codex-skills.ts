import { access, copyFile, lstat, mkdir, readFile, realpath, rm, readdir } from "node:fs/promises";
import { join, dirname, relative, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { BrowserSkillDelivery } from "./browser-skill-delivery.js";
import { readWorkerSkillManifest } from "./skill-policy.js";
import { parseSkillLibrary, snapshotSkillDirectory, verifySkillFiles } from "./skills-library.js";
import { parseEnvFile } from "./connector-env.js";
import type { TaskRef } from "./workflow.js";

export interface CodexSkillAssignment {
  task: TaskRef;
  workerId: string;
  /** Enforced by Main Agent/Runner integration after #144. */
  mandatory: boolean;
}
export interface CodexSkillInstallResult {
  assigned: boolean;
  installed: string[];
  reused: string[];
  specKitStage?: string;
}
const safeWorkerId = /^[A-Za-z0-9_-]{1,100}$/;
const same = (a: Record<string,string>, b: Record<string,string>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every(x=>a[x]===b[x]);

async function noSymlinkDirectory(path: string) {
  const st=await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Unsafe native skill directory");
}
function ownerSecretFromEnv(): string | undefined {
  const env = process.env.DEVOS_CONNECTOR_OWNER_SECRET?.trim();
  return env && Buffer.byteLength(env)>=32 ? env : undefined;
}
async function ownerSecret(root: string, provided?: string): Promise<string> {
  let secret=provided??ownerSecretFromEnv();
  if (!secret) {
    try {
      const vars=parseEnvFile(await readFile(join(root,".env"),"utf8"));
      secret=vars.DEVOS_CONNECTOR_OWNER_SECRET?.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
    }
  }
  if (!secret || Buffer.byteLength(secret)<32)
    throw new Error("Signed Codex skills need a configured local owner secret");
  return secret;
}
async function manifestExists(root: string, assignment: CodexSkillAssignment) {
  const path=join(root,".devos","skills","assignments",
    encodeURIComponent(assignment.task.repo),String(assignment.task.issue),
    assignment.workerId+".json");
  try {await access(path);return true;}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code==="ENOENT") return false;
    throw error;
  }
}
/** Codex loads the YAML frontmatter name, not the directory ID. */
function skillDisplayName(content: string, source: string): string {
  const match=/^---\r?\n([\s\S]{0,3000}?)\r?\n---/.exec(content);
  const line=match?.[1]?.split(/\r?\n/).find(x=>/^name\s*:/.test(x));
  const name=line?.replace(/^name\s*:\s*/,"").trim().replace(/^["']|["']$/g,"");
  if (!name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name))
    throw new Error("Invalid native Codex SKILL.md name: "+source);
  return name;
}
async function namesInSkillLocation(directory:string):Promise<Map<string,string>> {
  const names=new Map<string,string>();
  let children;
  try { children=await readdir(directory,{withFileTypes:true}); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code==="ENOENT") return names;
    throw error;
  }
  for (const item of children) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    if (item.name===".system") continue;
    const path=join(directory,item.name,"SKILL.md");
    let body:string;
    try { body=await readFile(path,"utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code==="ENOENT") continue;
      throw error;
    }
    const name=skillDisplayName(body,path);
    if (names.has(name)) throw new Error("Duplicate native Codex skill name: "+name);
    names.set(name,join(directory,item.name));
  }
  return names;
}
/** Native Codex preparation: no MCP calls, no global skill writes, no branches.
 * The signed worker assignment is the only source of selected skill IDs.
 */
export async function prepareCodexSkills(
  projectRoot: string,
  assignment: CodexSkillAssignment,
  options: {ownerSecret?: string; upstreamRoot?: string; userSkillDirectories?: string[]} = {},
): Promise<CodexSkillInstallResult> {
  const root=await realpath(projectRoot);
  if (!safeWorkerId.test(assignment.workerId) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(assignment.task.repo) ||
      !Number.isSafeInteger(assignment.task.issue) || assignment.task.issue<1)
    throw new Error("Invalid trusted Codex skill assignment context");
  if (!await manifestExists(root,assignment)) {
    if (assignment.mandatory) throw new Error("Required signed Codex skill assignment missing");
    // Existing task graphs predate #144; do not invent a skills selection.
    return {assigned:false,installed:[],reused:[]};
  }
  const agents=join(root,".agents"), nativeSkills=join(agents,"skills");
  await noSymlinkDirectory(agents);
  await noSymlinkDirectory(nativeSkills);
  const secret=await ownerSecret(root,options.ownerSecret);
  const manifest=await readWorkerSkillManifest(root,
    {repo:assignment.task.repo,issue:assignment.task.issue},assignment.workerId,secret);
  if (manifest.phase!=="execution" || manifest.role==="main_agent")
    throw new Error("Codex skill assignment is not for an execution worker");
  const upstreamRoot=options.upstreamRoot??process.env.DEVOS_UPSTREAM_ROOT??
    join(homedir(),".devos-staging","upstream");
  // Validate the complete signed manifest and original Spec Kit before touching
  // any existing skills. The delivery object performs local IO, not MCP.
  const delivery=new BrowserSkillDelivery(root,secret,upstreamRoot);
  const resources=await delivery.list({
    repo:assignment.task.repo,issue:assignment.task.issue,
    workerId:assignment.workerId,turn:0,
  });
  const policy=JSON.parse(await readFile(join(root,"config","devos-skills.json"),"utf8"));
  const catalog=parseSkillLibrary(policy);
  const upstreamLock=JSON.parse(await readFile(join(root,"config","devos-upstreams.lock.json"),"utf8")) as
    {sources:Array<{id:string;commit:string}>};
  const pins=Object.fromEntries(upstreamLock.sources.map(s=>[s.id,s.commit]));
  const roots={projectRoot:root,upstreamRoot,upstreamPins:pins};
  const actual=await realpath(nativeSkills);
  const escape=relative(root,actual);
  if (escape===".." || escape.startsWith(".."+sep) || isAbsolute(escape))
    throw new Error("Native Codex skills directory escapes worktree");
  const nativeNames=await namesInSkillLocation(nativeSkills);
  const globalDirs=options.userSkillDirectories??[
    join(homedir(),".agents","skills"),
    join(process.env.CODEX_HOME??join(homedir(),".codex"),"skills"),
  ];
  const globalNames=await Promise.all(globalDirs.map(namesInSkillLocation));
  const plannedNames=new Set<string>();
  const plan:Array<{id:string;source:string;files:Record<string,string>}>=[];
  const reused:string[]=[];
  for (const entry of resources) {
    if (entry.source==="spec-kit") {
      // Original installed skills are already tracked under .agents/skills;
      // the trusted delivery check above verified their pinned SHA.
      continue;
    }
    const skill=catalog.skills.find(x=>x.id===entry.id);
    if (!skill || skill.version!==entry.version)
      throw new Error("Pinned Codex skill version drift");
    if (skill.id.startsWith("speckit-"))
      throw new Error("Cannot shadow official Spec Kit native skills");
    const source=await verifySkillFiles(skill,roots);
    const dest=join(nativeSkills,skill.id);
    const skillName=skillDisplayName(await readFile(join(source,"SKILL.md"),"utf8"),source);
    if (plannedNames.has(skillName))
      throw new Error("Duplicate assigned native Codex skill name: "+skillName);
    plannedNames.add(skillName);
    const collides=nativeNames.get(skillName);
    if (collides && collides!==dest)
      throw new Error("Native Codex skill name collision: "+skillName);
    if (globalNames.some(names=>names.has(skillName)))
      throw new Error("User/global native Codex skill name collision: "+skillName);
    try {
      const st=await lstat(dest);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw new Error("Native skill name collision with existing file or symlink: "+skill.id);
      const current=await snapshotSkillDirectory(dest);
      if (!same(current,skill.files))
        throw new Error("Native skill collision: existing skills cannot be overwritten: "+skill.id);
      reused.push(skill.id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
      plan.push({id:skill.id,source,files:skill.files});
    }
  }
  const installed:string[]=[];
  for (const item of plan) {
    const dest=join(nativeSkills,item.id);
    await mkdir(dest); // exclusive; no rename-over-existing race
    try {
      for (const name of Object.keys(item.files)) {
        const dst=join(dest,name);
        await mkdir(dirname(dst),{recursive:true});
        await copyFile(join(item.source,name),dst);
      }
      if (!same(await snapshotSkillDirectory(dest),item.files))
        throw new Error("Native skill integrity failed after copy: "+item.id);
      installed.push(item.id);
    } catch (error) {
      await rm(dest,{recursive:true,force:true});
      throw error;
    }
  }
  return {assigned:true,installed,reused,
    ...(manifest.specKitStage?{specKitStage:manifest.specKitStage}:{})};
}
