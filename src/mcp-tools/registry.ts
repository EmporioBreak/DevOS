import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { WorkerReportTurn } from "../orchestrator.js";
import type { TaskRef } from "../workflow.js";
import { dirname, join } from "node:path";
import { JsonStateStore } from "../json-state-store.js";
import type { WorkerStatus } from "../workflow.js";
import { readSkillPolicy, policyFingerprint, updateSkillPreference, writeSkillPolicy } from "../skill-policy.js";
import { parseSkillLibrary } from "../skills-library.js";
import { SKILL_POLICY_WIDGET_URI } from "../skill-policy-widget.js";
import { BrowserSkillDelivery, type VerifiedWorkerIdentity } from "../browser-skill-delivery.js";
import { getSkillsDiagnostics, previewSkillsUpdate } from "../skill-diagnostics.js";
import { readPipelineSnapshot } from "../pipeline-diagnostics.js";
import type { WorkerSkillContext } from "../skill-policy.js";

const REPORT_STATUSES = new Set<WorkerStatus>([
  "done", "approved", "changes_requested", "needs_local_worker", "failed",
]);
export function reportTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function reportPath(root: string, task: TaskRef, turn: WorkerReportTurn): string {
  return join(root, ".devos", "worker-reports",
    `${encodeURIComponent(task.repo)}-issue-${task.issue}`,
    `turn-${turn.turn}-${turn.tokenHash}.json`);
}
type Arguments = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>;
  isError?: boolean; structuredContent?: Record<string, unknown> };

function textResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }],
    ...(value && typeof value === "object" && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> } : {}) };
}
function input(value: unknown): Arguments {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DevOS tool arguments must be an object");
  return value as Arguments;
}
function taskFrom(args: Arguments) {
  const repo = args.repo;
  const issue = args.issue;
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      repo.includes("..") || typeof issue !== "number" ||
      !Number.isSafeInteger(issue) || issue <= 0)
    throw new Error("Invalid task reference");
  return { repo, issue };
}
function exactKeys(args: Arguments, allowed: string[]) {
  if (Object.keys(args).some(key => !allowed.includes(key)))
    throw new Error("Unsupported DevOS tool argument");
}

export const DEVOS_TOOLS = [
  {
    name: "devos_pipeline_status",
    title: "DevOS Issue pipeline timeline",
    description: "Read-only owner-only Issue stage, worker skill versions, review handoff and bounded audit events. No chat URLs, tokens or private paths.",
    inputSchema:{type:"object",properties:{
      repo:{type:"string"},issue:{type:"integer",minimum:1},
    },required:["repo","issue"],additionalProperties:false},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "devos_skill_diagnostics",
    title: "DevOS Skills diagnostics",
    description: "Read-only owner-only audit of the pinned Skills Library, effective policy and optional GitHub Issue/worker skill set; no credentials or private profile paths returned.",
    inputSchema: {type:"object",properties:{
      repo:{type:"string"},issue:{type:"integer",minimum:1},
      worker_id:{type:"string"},role:{type:"string"},
      phase:{type:"string",enum:["planning","execution"]},
      spec_kit_stage:{type:["string","null"]},
      optional_candidates:{type:"array",items:{type:"string"}},
    },additionalProperties:false},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "devos_skill_update_preview",
    title: "Review a pinned skill version diff",
    description: "Read-only preview of proposed SKILL.md/assets version hashes and adaptation dependencies. This never installs, applies, merges or deploys a skill. Main Agent approval and a reviewed GitHub PR are still required.",
    inputSchema:{type:"object",properties:{
      skill_id:{type:"string"},
      candidate_json:{type:"string",maxLength:65536,
        description:"JSON Skills Library entry for the candidate revision; never send credentials"},
    },required:["skill_id","candidate_json"],additionalProperties:false},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "devos_skill_manifest",
    title: "List skills assigned to this DevOS browser worker",
    description: "Read the exact pinned skill list for this active verified DevOS browser worker. Identity comes from the server's host-confirmed chat grant, never tool arguments. An ordinary owner chat cannot impersonate a worker.",
    inputSchema: {type:"object",properties:{},additionalProperties:false},
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "devos_skill_search",
    title: "Search this worker's assigned DevOS skills",
    description: "Search only pinned skills assigned to the current verified browser worker; cannot enumerate other projects or workers.",
    inputSchema: {type:"object",properties:{query:{type:"string",maxLength:120}},
      required:["query"],additionalProperties:false},
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "devos_skill_read",
    title: "Read an assigned pinned DevOS skill resource",
    description: "Read SKILL.md or named references/scripts/assets of a skill already assigned to this verified browser worker. Strict SHA-256 and path checks; returns read-only resources, never executes scripts.",
    inputSchema: {type:"object",properties:{
      skill_id:{type:"string"},resource:{type:"string"},
    },required:["skill_id","resource"],additionalProperties:false},
    annotations: {readOnlyHint:true,destructiveHint:false,openWorldHint:false},
  },
  {
    name: "devos_skill_policy_get",
    title: "DevOS skill preferences",
    description: "Read available Skills Library names and versioned global/project/role/task preferences. Requires an already owner-approved DevOS chat. Call when user asks to configure skills, not automatically in a new chat.",
    inputSchema: {
      type: "object", properties: {}, additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: SKILL_POLICY_WIDGET_URI },
      "openai/outputTemplate": SKILL_POLICY_WIDGET_URI,
      "openai/widgetAccessible": true },
  },
  {
    name: "devos_skill_policy_set",
    title: "Update DevOS skill preference",
    description: "Set one skill mode required/optional/off at global/project/role/task scope. Requires an already owner-approved DevOS chat. Read devos_skill_policy_get first; pass its exact fingerprint to avoid overwriting concurrent settings. Does not start a DevOS worker or modify GitHub automatically.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "Registered Skills Library ID" },
        mode: { type: "string", enum: ["required","optional","off"] },
        scope: { type: "string", enum: ["global","project","role","task"] },
        context: { type: "string", description: "project owner/repo, role name, or task owner/repo#issue; omit for global" },
        expected_fingerprint: { type: "string", description: "64-hex current policy fingerprint returned by devos_skill_policy_get" },
      },
      required: ["skill_id","mode","scope","expected_fingerprint"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { "openai/widgetAccessible": true },
  },
  {
    name: "devos_task_status",
    title: "DevOS task status",
    description: "Read the current local DevOS task progress without exposing browser session URLs.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub owner/repository" },
        issue: { type: "integer", minimum: 1 },
      },
      required: ["repo", "issue"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "devos_worker_report",
    title: "Record DevOS worker report",
    description: "Final worker status report: after validation and durable recording, DevOS may finish the current browser worker turn immediately, without waiting for ChatGPT final SSE/text. Call ONLY after completing all work and posting required GitHub evidence. The main agent still owns final task approval.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "GitHub owner/repository" },
        issue: { type: "integer", minimum: 1 },
        worker_id: { type: "string", minLength: 1, maxLength: 100 },
        turn: { type: "integer", minimum: 0, description: "Current completedRuns from devos_task_status" },
        status: { type: "string", enum: [...REPORT_STATUSES] },
        summary: { type: "string", minLength: 1, maxLength: 4096 },
        turn_token: { type: "string", minLength: 64, maxLength: 64, description: "One-turn token provided in the worker's task prompt" },
      },
      required: ["repo", "issue", "worker_id", "turn", "status", "summary", "turn_token"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
] as const;

export class DevosToolRegistry {
  constructor(private readonly root: string, private readonly ownerSecret?: string) {}

  has(name: string): boolean {
    return DEVOS_TOOLS.some(tool => tool.name === name);
  }

  list(): Array<Record<string, unknown>> {
    return DEVOS_TOOLS.map(tool => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
      _meta: {
        ...("_meta" in tool ? tool._meta : {}),
        securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
      },
    }));
  }

  async readReport(task: TaskRef, active: WorkerReportTurn): Promise<WorkerStatus | null> {
    let raw: string;
    try { raw = await readFile(reportPath(this.root, task, active), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("Invalid recorded DevOS worker report");
    const report = record as Record<string, unknown>;
    if (report.task && JSON.stringify(report.task) === JSON.stringify({repo: task.repo, issue: task.issue}) &&
        report.worker_id === active.workerId && report.turn === active.turn &&
        report.token_hash === active.tokenHash &&
        typeof report.status === "string" && REPORT_STATUSES.has(report.status as WorkerStatus) &&
        typeof report.summary === "string" && report.summary.length > 0)
      return report.status as WorkerStatus;
    throw new Error("Recorded DevOS worker report identity or content mismatch");
  }

  /** One report terminates browser waiting. Poll only for this authorized
   * turn, stop immediately on AbortSignal, and never invent a status. */
  async waitForReport(
    task: TaskRef, active: WorkerReportTurn, signal: AbortSignal,
    intervalMs = 100,
  ): Promise<WorkerStatus> {
    while (!signal.aborted) {
      const status = await this.readReport(task, active);
      if (status) return status;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.max(25, intervalMs));
        function done() { signal.removeEventListener("abort", done); clearTimeout(timer); resolve(); }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    throw new Error("MCP report observer stopped");
  }

  async call(
    name: string, argumentsValue: unknown,
    trustedWorker?: VerifiedWorkerIdentity | null,
  ): Promise<ToolResult> {
    if (!this.has(name)) throw new Error("Unknown DevOS tool");
    try {
      const args = input(argumentsValue);
      if (name === "devos_skill_manifest" || name === "devos_skill_search" ||
          name === "devos_skill_read") {
        if (!trustedWorker)
          throw new Error("Skill access requires a server-verified active DevOS worker grant");
        if (!this.ownerSecret) throw new Error("Server owner secret required for pinned browser skills");
        const delivery = new BrowserSkillDelivery(this.root,this.ownerSecret);
        if (name === "devos_skill_manifest") {
          exactKeys(args, []);
          return textResult({skills:await delivery.list(trustedWorker)});
        }
        if (name === "devos_skill_search") {
          exactKeys(args, ["query"]);
          if (typeof args.query !== "string") throw new Error("Invalid skill search query");
          return textResult({skills:await delivery.search(trustedWorker,args.query)});
        }
        exactKeys(args, ["skill_id","resource"]);
        if (typeof args.skill_id !== "string" || typeof args.resource !== "string")
          throw new Error("Invalid pinned skill resource request");
        return textResult(await delivery.read(trustedWorker,args.skill_id,args.resource));
      }
      if (name === "devos_skill_diagnostics") {
        exactKeys(args, ["repo","issue","worker_id","role","phase",
          "spec_kit_stage","optional_candidates"]);
        const anyContext=Object.keys(args).length>0;
        let context:WorkerSkillContext|undefined;
        if (anyContext) {
          if (typeof args.repo!=="string" || typeof args.issue!=="number" ||
              !Number.isSafeInteger(args.issue) || args.issue<=0 ||
              typeof args.worker_id!=="string" || typeof args.role!=="string" ||
              (args.phase!=="planning" && args.phase!=="execution") ||
              (args.spec_kit_stage!==null && typeof args.spec_kit_stage!=="string") ||
              (args.optional_candidates!==undefined &&
                (!Array.isArray(args.optional_candidates) ||
                 args.optional_candidates.some(x=>typeof x!=="string"))))
            throw new Error("Complete Issue/worker/role/phase/stage context required");
          context={repo:args.repo,issue:args.issue,workerId:args.worker_id,
            role:args.role,phase:args.phase,
            specKitStage:args.spec_kit_stage as string|null,
            optionalCandidates:args.optional_candidates as string[]|undefined ?? []};
        }
        return textResult(await getSkillsDiagnostics(this.root,{
          ...(this.ownerSecret?{ownerSecret:this.ownerSecret}:{}),
          ...(context?{context}:{}),
        }));
      }
      if (name === "devos_skill_update_preview") {
        exactKeys(args,["skill_id","candidate_json"]);
        if (typeof args.skill_id!=="string" ||
            typeof args.candidate_json!=="string" ||
            Buffer.byteLength(args.candidate_json)>65_536)
          throw new Error("Invalid skill update preview arguments");
        const candidate:unknown=JSON.parse(args.candidate_json);
        return textResult(await previewSkillsUpdate(this.root,args.skill_id,
          candidate as Parameters<typeof previewSkillsUpdate>[2]));
      }
      if (name === "devos_skill_policy_get" || name === "devos_skill_policy_set") {
        const catalog = parseSkillLibrary(JSON.parse(
          await readFile(join(this.root, "config", "devos-skills.json"), "utf8")));
        const current = await readSkillPolicy(this.root);
        if (name === "devos_skill_policy_get") {
          exactKeys(args, []);
          return textResult({
            version: 1,
            fingerprint: policyFingerprint(current),
            policy: current,
            skills: catalog.skills.map(skill => ({
              id: skill.id, name: skill.name, description: skill.description,
              version: skill.version, origin: skill.source.kind,
            })),
          });
        }
        exactKeys(args, ["skill_id", "mode", "scope", "context", "expected_fingerprint"]);
        if (typeof args.skill_id !== "string" || typeof args.mode !== "string" ||
            typeof args.scope !== "string" ||
            typeof args.expected_fingerprint !== "string")
          throw new Error("Invalid skill preference update arguments");
        const preference = {
          skillId: args.skill_id,
          mode: args.mode,
          scope: args.scope,
          ...(args.context === undefined ? {} : {context: args.context}),
        };
        const policy = updateSkillPreference(current,
          preference as Parameters<typeof updateSkillPreference>[1], catalog);
        const fingerprint = await writeSkillPolicy(this.root,policy,args.expected_fingerprint);
        return textResult({updated:true,policy,fingerprint,
          git_status:"Local Git-backed settings updated; commit/PR remains Main Agent responsibility"});
      }
      const task = taskFrom(args);
      if(name === "devos_pipeline_status"){
        exactKeys(args,["repo","issue"]);
        return textResult(await readPipelineSnapshot(this.root,task,this.ownerSecret));
      }
      if (name === "devos_task_status") {
        exactKeys(args, ["repo", "issue"]);
        const state = await new JsonStateStore(this.root, task).load();
        if (!state) return textResult({ found: false, task });
        return textResult({
          found: true, task,
          worker_id: state.currentWorkerId,
          turn: state.completedRuns,
          review_loops: state.reviewLoops ?? 0,
          main_agent_review_pending: state.mainAgentReviewPending ?? false,
          completion_approved: state.completionApproved ?? false,
        });
      }

      exactKeys(args, ["repo", "issue", "worker_id", "turn", "status", "summary", "turn_token"]);
      const { worker_id: worker, turn, status, summary, turn_token: token } = args;
      if (typeof worker !== "string" || !worker.trim() || worker.length > 100 ||
          typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0 ||
          typeof status !== "string" || !REPORT_STATUSES.has(status as WorkerStatus) ||
          typeof summary !== "string" || !summary.trim() || summary.length > 4096 ||
          typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
        throw new Error("Invalid worker report");

      const state = await new JsonStateStore(this.root, task).load();
      const active = state?.activeReport;
      const receivedHash = reportTokenHash(token);
      if (!state || state.currentWorkerId !== worker || state.completedRuns !== turn ||
          state.mainAgentReviewPending || state.completionApproved ||
          active?.workerId !== worker || active.turn !== turn ||
          !timingSafeEqual(Buffer.from(active.tokenHash, "hex"), Buffer.from(receivedHash, "hex")))
        throw new Error("No matching active worker turn");

      // Reports are untrusted evidence, not orchestration authority. Never mutate task state.
      const report = { task, worker_id: worker, turn, status, summary, token_hash: active.tokenHash };
      const path = reportPath(this.root, task, active);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // Publish by atomic hard-link: the observer must never read a partially
      // written JSON file. Linking with EEXIST preserves idempotent first-write-wins.
      const staging = path + "." + randomUUID() + ".tmp";
      try {
        await writeFile(staging, JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
        try {
          await link(staging, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const previous = JSON.parse(await readFile(path, "utf8")) as unknown;
          if (JSON.stringify(previous) !== JSON.stringify(report))
            throw new Error("Conflicting report already recorded for this worker turn");
        }
      } finally {
        await rm(staging, { force: true });
      }
      return textResult({ recorded: true, authoritative: true, task, worker_id: worker, turn });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "DevOS tool failed" }] };
    }
  }
}
