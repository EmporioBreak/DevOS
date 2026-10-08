import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalPrivateChatUrl } from "./chat-access.js";
import { ChatWorkerProbeRegistry, exactWorkerProbeResult } from "./chat-worker-probe.js";
import { parseEnvFile } from "./connector-env.js";
import type { TaskRef } from "./workflow.js";

interface WorkerGrant {
  fingerprint: string;
  repo: string;
  issue: number;
  workerId: string;
  turn: number;
  url: string;
  expiresAt: number;
}
interface WorkerGrantFile { version: 1; entries: WorkerGrant[]; mac: string }
const MAX_GRANTS = 256;
const GRANT_TTL_MS = 30 * 60_000;
const FINGERPRINT = /^chat_[a-f0-9]{64}$/;

function validGrant(g: WorkerGrant): boolean {
  try {
    return !!g && FINGERPRINT.test(g.fingerprint) &&
      typeof g.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(g.repo) &&
      Number.isSafeInteger(g.issue) && g.issue > 0 &&
      typeof g.workerId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(g.workerId) &&
      Number.isSafeInteger(g.turn) && g.turn >= 0 &&
      typeof g.url === "string" && canonicalPrivateChatUrl(g.url) === g.url &&
      Number.isSafeInteger(g.expiresAt) && g.expiresAt > 0;
  } catch { return false; }
}

function activeWorker(root: string, grant: WorkerGrant): boolean {
  const path = join(root, ".devos", "state", `${encodeURIComponent(grant.repo)}-issue-${grant.issue}.json`);
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return state.currentWorkerId === grant.workerId &&
      state.completedRuns === grant.turn &&
      state.activeReport?.workerId === grant.workerId &&
      state.activeReport?.turn === grant.turn &&
      state.mainAgentReviewPending !== true &&
      state.completionApproved !== true &&
      state.sessions?.[grant.workerId] === grant.url;
  } catch { return false; }
}

/** Only the on-host executor can create grants, after a browser proof.
 * The gateway checks local task state on EACH operation; stale turn grants
 * are immediately ineffective even before the file is explicitly pruned. */
export class ChatWorkerGrantRegistry {
  private readonly file: string;
  private readonly key: Buffer;
  constructor(private readonly root: string, private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error("Worker access requires owner secret");
    this.file = join(root, ".devos", "connector", "worker-grants.json");
    this.key = createHash("sha256").update("DevOS worker grant v1\0").update(secret).digest();
  }
  private mac(entries: WorkerGrant[]): string {
    return createHmac("sha256", this.key).update("grants\0").update(JSON.stringify({version:1,entries})).digest("hex");
  }
  private read(): WorkerGrant[] {
    if (!existsSync(this.file)) return [];
    const st = lstatSync(this.file);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("Insecure worker grants");
    const data = JSON.parse(readFileSync(this.file, "utf8")) as WorkerGrantFile;
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_GRANTS ||
        data.entries.some(g => !validGrant(g)) || new Set(data.entries.map(g=>g.fingerprint)).size !== data.entries.length ||
        typeof data.mac !== "string" || !/^[a-f0-9]{64}$/.test(data.mac) ||
        !timingSafeEqual(Buffer.from(data.mac,"hex"),Buffer.from(this.mac(data.entries),"hex")))
      throw new Error("Worker grants integrity failure");
    return data.entries;
  }
  private save(entries: WorkerGrant[]): void {
    if (entries.length > MAX_GRANTS) throw new Error("Worker grant capacity exceeded");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp=this.file+"."+process.pid+"."+randomUUID()+".tmp";
    try {
      writeFileSync(temp,JSON.stringify({version:1,entries,mac:this.mac(entries)})+"\n",{flag:"wx",mode:0o600});
      renameSync(temp,this.file);
    } finally { try{unlinkSync(temp)}catch{} }
  }
  isGranted(fingerprint: string | undefined, now=Date.now()): boolean {
    if (!fingerprint || !FINGERPRINT.test(fingerprint)) return false;
    try {
      const grant=this.read().find(g=>g.fingerprint===fingerprint && g.expiresAt>now);
      return !!grant && activeWorker(this.root,grant);
    } catch { return false; }
  }
  /** Called only by the trusted local browser executor. The nonce alone does
   * nothing; caller must establish provider-structured exact-chat evidence. */
  bindVerified(
    nonce: string, task: TaskRef, workerId: string, turn: number,
    url: string, now=Date.now(),
  ): boolean {
    if (!task || !Number.isSafeInteger(task.issue) || !Number.isSafeInteger(turn) || !workerId) return false;
    let exact: string;
    try { exact=canonicalPrivateChatUrl(url); } catch { return false; }
    if (exact!==url) return false;
    const template = { fingerprint:"chat_"+ "0".repeat(64), repo:task.repo, issue:task.issue, workerId, turn, url, expiresAt:now+GRANT_TTL_MS };
    if (!validGrant(template) || !activeWorker(this.root,template)) return false;
    const probe = new ChatWorkerProbeRegistry(this.root,this.secret);
    const fingerprint=probe.claim(nonce,now);
    if (!fingerprint) return false;
    const grant={...template,fingerprint};
    try {
      const existing=this.read();
      const conflict=existing.find(g=>g.expiresAt>now && activeWorker(this.root,g) &&
        ((g.fingerprint===fingerprint &&
          (g.repo!==task.repo || g.issue!==task.issue || g.workerId!==workerId || g.url!==url)) ||
         (g.fingerprint!==fingerprint && g.repo===task.repo && g.issue===task.issue &&
          g.workerId===workerId && g.turn===turn)));
      // Two distinct host MCP sessions must never simultaneously represent the
      // same active worker turn. A rotated session needs a fresh turn or
      // explicit local revocation, not an implicit duplicate grant.
      if (conflict) return false;
      const remaining=existing.filter(g=>g.fingerprint!==fingerprint && g.expiresAt>now && activeWorker(this.root,g));
      this.save([...remaining,grant]);
      return true;
    } catch { return false; }
  }
  revoke(task: TaskRef, workerId: string): void {
    const records=this.read();
    this.save(records.filter(g=>!(g.repo===task.repo && g.issue===task.issue && g.workerId===workerId)));
  }
}

/** Browser process reads owner-only LOCAL environment; never sends the secret
 * through a model prompt, MCP arguments, browser JS, logs or GitHub. */
export function localWorkerAuthorization(root: string): {
  registry: ChatWorkerGrantRegistry; resourceUri: string;
} | null {
  let file: Record<string,string>={};
  try { file=parseEnvFile(readFileSync(join(root,".env"),"utf8")); } catch {}
  const secret=process.env.DEVOS_CONNECTOR_OWNER_SECRET?.trim() || file.DEVOS_CONNECTOR_OWNER_SECRET?.trim() || "";
  // A resource pin is set through a trusted LOCAL operation after observing
  // the installed ChatGPT connector identity. A copied link/prompt may not pin
  // or grant a worker from an untrusted chat.
  let pinned="";
  try {
    const path=join(root,".devos","connector","worker-probe-resource-uri");
    const st=lstatSync(path);
    if (st.isFile() && (st.mode & 0o077)===0) pinned=readFileSync(path,"utf8").trim();
  } catch {}
  const resourceUri=process.env.DEVOS_WORKER_PROBE_RESOURCE_URI?.trim() ||
    file.DEVOS_WORKER_PROBE_RESOURCE_URI?.trim() || pinned;
  if (Buffer.byteLength(secret)<32 || !/^\/[^/?]+\/[^/?]+\/devos_worker_probe$/.test(resourceUri)) return null;
  return { registry:new ChatWorkerGrantRegistry(root,secret), resourceUri };
}

/** No authorization unless the exact app tool response is provider-authored
 * in the active worker's saved conversation and the local state matches. */
export function bindProvenWorkerMessage(root: string, task: TaskRef, workerId: string, turn: number,
  url: string, message: unknown, now=Date.now()): boolean {
  const local=localWorkerAuthorization(root);
  if (!local) return false;
  const nonce=exactWorkerProbeResult(message,local.resourceUri);
  return !!nonce && local.registry.bindVerified(nonce,task,workerId,turn,url,now);
}
