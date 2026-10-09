import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { readWorkerSkillManifest } from "./skill-policy.js";
import {
  parseSkillLibrary, readPinnedSkillResource, verifySkillFiles,
  type SkillRoots,
} from "./skills-library.js";

export interface VerifiedWorkerIdentity {
  repo:string;
  issue:number;
  workerId:string;
  turn:number;
}
export interface BrowserSkillEntry {
  id:string;
  version:string;
  name:string;
  description:string;
  availableResources:string[];
  source:"spec-kit"|"skills-library";
  reason:string;
}

function safeFile(name:string):string {
  if (!name || typeof name!=="string" || name.includes("\\") ||
      name.includes("\0") || name.startsWith("/") ||
      name.split("/").some(part=>!part||part==="."||part===".."))
    throw new Error("Unsafe skill resource path");
  return name;
}
function safeText(text:string,max=120):string {
  if (typeof text!=="string"||text.length>max ||
      /[\x00-\x1f]/.test(text)) throw new Error("Invalid skill search text");
  return text;
}
export class BrowserSkillDelivery {
  constructor(
    private readonly root:string,
    private readonly secret:string,
    private readonly upstreamRoot:string =
      process.env.DEVOS_UPSTREAM_ROOT || join(homedir(),".devos-staging","upstream"),
  ) {}
  private async pinnedRoots(): Promise<SkillRoots> {
    const source = JSON.parse(await readFile(join(this.root,"config","devos-upstreams.lock.json"),"utf8")) as {
      version:number;sources:Array<{id:string;commit:string}>;
    };
    if (source.version!==1 || !Array.isArray(source.sources))
      throw new Error("Invalid pinned upstream manifest");
    const pins:Record<string,string>={};
    for (const entry of source.sources) {
      if (!/^[a-z][a-z0-9-]+$/.test(entry.id) ||
          !/^[a-f0-9]{40}$/.test(entry.commit) || pins[entry.id])
        throw new Error("Invalid pinned upstream source");
      pins[entry.id]=entry.commit;
    }
    return {projectRoot:this.root,upstreamRoot:this.upstreamRoot,upstreamPins:pins};
  }
  private async snapshot(identity:VerifiedWorkerIdentity) {
    if (!identity || !Number.isSafeInteger(identity.turn) || identity.turn<0)
      throw new Error("Missing server-verified worker identity");
    const manifest=await readWorkerSkillManifest(this.root,
      {repo:identity.repo,issue:identity.issue},identity.workerId,this.secret);
    const catalog=parseSkillLibrary(JSON.parse(
      await readFile(join(this.root,"config","devos-skills.json"),"utf8")));
    return {manifest,catalog,roots:await this.pinnedRoots()};
  }
  private async stageResource(stage:string):Promise<Buffer> {
    const pins=JSON.parse(await readFile(join(this.root,"config","devos-speckit-stage-pins.json"),"utf8")) as {
      version:number;upstream:string;release:string;stages:Record<string,{
        skillId:string;path:string;sha256:string;
      }>;
    };
    const pin=pins.stages?.[stage], expected=".agents/skills/speckit-"+stage+"/SKILL.md";
    if (pins.version!==1 || pins.upstream!=="github/spec-kit" ||
        pins.release!=="v1.1.2" || !pin ||
        pin.skillId!=="speckit-"+stage || pin.path!==expected ||
        !/^[a-f0-9]{64}$/.test(pin.sha256))
      throw new Error("Untrusted original Spec Kit stage");
    const root=await realpath(this.root);
    const full=await realpath(join(root,expected));
    const diff=relative(root,full);
    if (!diff || diff===".." || diff.startsWith(".."+sep) || isAbsolute(diff))
      throw new Error("Original Spec Kit stage escapes root");
    const bytes=await readFile(full);
    if (createHash("sha256").update(bytes).digest("hex")!==pin.sha256)
      throw new Error("Original Spec Kit stage integrity failed");
    return bytes;
  }
  async list(identity:VerifiedWorkerIdentity):Promise<BrowserSkillEntry[]> {
    const {manifest,catalog,roots}=await this.snapshot(identity);
    const entries:BrowserSkillEntry[]=[];
    if (manifest.specKitStage) {
      await this.stageResource(manifest.specKitStage);
      entries.push({
        id:"speckit-"+manifest.specKitStage,version:"1.1.2",
        name:"Original Spec Kit "+manifest.specKitStage,
        description:"Mandatory original Spec Kit stage, pinned to v1.1.2",
        availableResources:["SKILL.md"],source:"spec-kit",
        reason:"mandatory original stage",
      });
    }
    for (const ref of manifest.selected) {
      const skill=catalog.skills.find(x=>x.id===ref.id);
      if (!skill || skill.version!==ref.version)
        throw new Error("Worker skill assignment differs from pinned library");
      await verifySkillFiles(skill,roots);
      entries.push({
        id:skill.id,version:skill.version,name:skill.name,
        description:skill.description,
        availableResources:Object.keys(skill.files).sort(),
        source:"skills-library",reason:ref.rule,
      });
    }
    return entries;
  }
  async search(identity:VerifiedWorkerIdentity,query:string):Promise<BrowserSkillEntry[]> {
    const term=safeText(query).trim().toLowerCase();
    const available=await this.list(identity);
    return term?available.filter(x=>
      (x.id+" "+x.name+" "+x.description).toLowerCase().includes(term)) : available;
  }
  async read(identity:VerifiedWorkerIdentity,skillId:string,resource:string) {
    if (typeof skillId!=="string" || !/^[a-z][a-z0-9-]*$/.test(skillId))
      throw new Error("Invalid selected skill identity");
    const path=safeFile(resource);
    const {manifest,catalog,roots}=await this.snapshot(identity);
    let bytes:Buffer,version:string,sha256:string;
    if (skillId.startsWith("speckit-")) {
      const stage=skillId.slice("speckit-".length);
      if (!manifest.specKitStage || stage!==manifest.specKitStage || path!=="SKILL.md")
        throw new Error("Original Spec Kit stage not assigned to active worker");
      bytes=await this.stageResource(stage);
      version="1.1.2";
      sha256=createHash("sha256").update(bytes).digest("hex");
    } else {
      const assigned=manifest.selected.find(x=>x.id===skillId);
      const skill=catalog.skills.find(x=>x.id===skillId);
      if (!assigned || !skill || assigned.version!==skill.version)
        throw new Error("Skill is not assigned to this worker");
      bytes=await readPinnedSkillResource(skill,path,roots);
      version=assigned.version;
      sha256=skill.files[path]!;
    }
    if (bytes.byteLength>1024*1024)
      throw new Error("Skill resource too large for an MCP text response");
    let encoding:"utf8"|"base64"="utf8", content:string;
    try {
      content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
      if (content.includes("\0")) throw new Error("Binary");
    } catch {
      content=bytes.toString("base64");encoding="base64";
    }
    return {
      skill_id:skillId,version,resource:path,sha256,
      encoding,content,bytes:bytes.byteLength,read_only:true,
      execution_allowed:false,
      note:"Resources and scripts are delivered read-only. Execution, when required, follows the already-declared DevOS worker/fallback route.",
    };
  }
}
