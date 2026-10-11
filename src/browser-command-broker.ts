import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import {
  assertBrowserDocumentClaim,
  matchBrowserReceiptIdentity,
  verifyBrowserCommandAuthorization,
  verifyBrowserCommandExecution,
  type BrowserDocumentClaim,
  type BrowserDocumentObservation,
  type BrowserProviderReceiptIdentity,
} from "./browser-command-identity.js";
import { parseEnvFile } from "./connector-env.js";

export type BrowserCommand = BrowserDocumentClaim;
export type BrowserCommandStatus = "prepared" | "claimed" | "ambiguous" | "received" | "acknowledged";

interface CommandRecord {
  version: 1;
  command: BrowserCommand;
  status: BrowserCommandStatus;
  preparedAt: string;
  claimedAt?: string;
  receipt?: BrowserProviderReceiptIdentity;
  receivedAt?: string;
  acknowledgedAt?: string;
}
interface SignedRecord { record: CommandRecord; mac: string }
interface BrokerLockRecord {
  version: 1;
  pid: number;
  process: { pid: number; startTime: string; executable: string; commandLineSha256: string };
  token: string;
  createdAt: string;
}
interface SignedBrokerLock { lock: BrokerLockRecord; mac: string }

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID = /^[A-Za-z0-9_.:-]{1,192}$/;
const HEX = /^[a-f0-9]{64}$/;
const STATUS = new Set<BrowserCommandStatus>(["prepared", "claimed", "ambiguous", "received", "acknowledged"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);

/**
 * One durable claim boundary for every native ChatGPT browser command in this
 * installed DevOS project. A claim is committed before the caller may Send;
 * claimed and ambiguous records are never replayed after process restart.
 * This class records provider evidence but does not itself click or Send.
 */
export class BrowserCommandBroker {
  private readonly dir: string;
  private readonly keyPath: string;
  private keyPromise?: Promise<Buffer>;
  private ownerSecretPromise?: Promise<string>;

  constructor(private readonly projectRoot: string, private readonly providedOwnerSecret?: string) {
    this.dir = join(projectRoot, ".devos", "browser-runtime", "command-outbox");
    this.keyPath = join(this.dir, "signing.key");
  }

  async prepare(command: BrowserCommand): Promise<void> {
    validateCommand(command);
    if (!verifyBrowserCommandAuthorization(command, await this.ownerSecret()))
      throw new Error("Browser command lacks a valid owner-signed active graph and worker assignment");
    if(!verifyBrowserCommandExecution(command,await this.ownerSecret()))
      throw new Error("Browser command lacks a valid native execution attestation for its exact page and payload");
    await this.withLock(command.commandId, async () => {
      const prior = await this.read(command.commandId);
      if (prior) {
        if (canonical(prior.command) !== canonical(command))
          throw new Error("Conflicting browser command identity for existing outbox entry");
        return;
      }
      await this.write(command.commandId, {
        version: 1, command: structuredClone(command), status: "prepared",
        preparedAt: new Date().toISOString(),
      });
    });
  }

  /** Returns true only to the one process that atomically claims this Send. */
  async claim(commandId: string, observed: BrowserDocumentObservation,
    verifyCurrentAuthority?:()=>Promise<void>): Promise<boolean> {
    return this.withLock(commandId, async () => {
      const record = await this.require(commandId);
      if(record.command.expiresAt<=Date.now())
        throw new Error("Browser command authorization expired before native Send");
      await verifyCurrentAuthority?.();
      assertBrowserDocumentClaim(record.command, observed);
      if (record.status !== "prepared") return false;
      await this.write(commandId, { ...record, status: "claimed", claimedAt: new Date().toISOString() });
      return true;
    });
  }

  /** Persist provider-origin evidence before acknowledging command completion. */
  async recordProviderReceipt(commandId: string, receipt: BrowserProviderReceiptIdentity): Promise<void> {
    await this.withLock(commandId, async () => {
      const record = await this.require(commandId);
      matchBrowserReceiptIdentity(record.command, receipt);
      if (record.status === "received" || record.status === "acknowledged") {
        if (canonical(record.receipt) !== canonical(receipt))
          throw new Error("Conflicting provider receipt for browser command");
        return;
      }
      if (record.status !== "claimed" && record.status !== "ambiguous")
        throw new Error("Provider receipt requires a claimed browser command");
      await this.write(commandId, {
        ...record, status: "received", receipt: structuredClone(receipt),
        receivedAt: new Date().toISOString(),
      });
    });
  }

  async acknowledge(commandId: string, receipt: BrowserProviderReceiptIdentity): Promise<void> {
    await this.withLock(commandId, async () => {
      const record = await this.require(commandId);
      matchBrowserReceiptIdentity(record.command, receipt);
      if (record.status === "acknowledged") {
        if (canonical(record.receipt) !== canonical(receipt))
          throw new Error("Conflicting provider receipt after browser command acknowledgement");
        return;
      }
      if (record.status !== "received" || canonical(record.receipt) !== canonical(receipt))
        throw new Error("Browser command ACK requires its persisted exact provider receipt");
      await this.write(commandId, { ...record, status: "acknowledged", acknowledgedAt: new Date().toISOString() });
    });
  }

  async markAmbiguous(commandId: string): Promise<void> {
    await this.withLock(commandId, async () => {
      const record = await this.require(commandId);
      if (record.status === "ambiguous") return;
      if (record.status !== "claimed")
        throw new Error("Only a claimed browser command can become ambiguous");
      await this.write(commandId, { ...record, status: "ambiguous" });
    });
  }

  async get(commandId: string): Promise<Readonly<CommandRecord> | null> {
    return await this.read(commandId);
  }

  private path(commandId: string): string { return join(this.dir, `${digest(commandId)}.json`); }

  private ownerSecret(): Promise<string> {
    return this.ownerSecretPromise ??= (async () => {
      if (this.providedOwnerSecret) return this.providedOwnerSecret;
      const fromEnv=process.env.DEVOS_CONNECTOR_OWNER_SECRET?.trim();
      if (fromEnv && Buffer.byteLength(fromEnv)>=32) return fromEnv;
      try {
        const env=parseEnvFile(await readFile(join(this.projectRoot,".env"),"utf8"));
        const secret=env.DEVOS_CONNECTOR_OWNER_SECRET?.trim();
        if (secret && Buffer.byteLength(secret)>=32) return secret;
      } catch {}
      throw new Error("Browser command broker requires the existing local owner signing secret");
    })();
  }

  private async withLock<T>(commandId: string, operation: () => Promise<T>): Promise<T> {
    if (!ID.test(commandId)) throw new Error("Invalid browser command ID");
    await this.ensureDirectory();
    const lockPath = `${this.path(commandId)}.lock`;
    const key = await this.signingKey();
    const identity = await captureProcessIdentity(process.pid);
    if (!identity) throw new Error("Cannot prove current process identity for browser command lock");
    const lock: BrokerLockRecord = {
      version: 1, pid: process.pid,
      process: { pid: identity.pid, startTime: identity.startTime, executable: identity.executable,
        commandLineSha256: digest(identity.commandLine ?? "") },
      token: randomUUID(), createdAt: new Date().toISOString(),
    };
    const signed: SignedBrokerLock = {
      lock, mac: createHmac("sha256", key).update(canonical(lock)).digest("hex"),
    };
    const deadline = Date.now() + 5_000;
    while (true) {
      const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
      let published = false;
      try {
        const temp = await open(tempPath, "wx", 0o600);
        try { await temp.writeFile(`${canonical(signed)}\n`); await temp.sync(); }
        finally { await temp.close(); }
        try { await link(tempPath, lockPath); published = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } finally { await rm(tempPath, { force: true }); }

      if (published) {
        try {
          const directory = await open(dirname(lockPath), "r");
          try { await directory.sync(); }
          finally { await directory.close(); }
          return await operation();
        }
        finally { await this.releaseLock(lockPath, lock.token); }
      }

      if (await this.reclaimDeadLock(lockPath, key)) continue;
      if (Date.now() >= deadline)
        throw new Error("Browser command is concurrently locked or has an interrupted operation; refusing replay");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  /** Only reclaim a published lock whose signed PID/start identity is proven dead. */
  private async reclaimDeadLock(lockPath: string, key: Buffer): Promise<boolean> {
    let raw: string;
    try { raw = await readFile(lockPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (raw.length > 4_096) throw new Error("Browser command lock record exceeds capacity");
    let stat;
    try { stat = await lstat(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Unsafe browser command lock; refusing to reclaim it");
    let signed: SignedBrokerLock;
    try { signed = JSON.parse(raw) as SignedBrokerLock; }
    catch { throw new Error("Browser command lock has no verifiable owner; refusing to reclaim it"); }
    const owner = signed?.lock;
    if (!owner || owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
        owner.process?.pid !== owner.pid || typeof owner.process.startTime !== "string" ||
        typeof owner.process.executable !== "string" || !HEX.test(owner.process.commandLineSha256 ?? "") ||
        typeof owner.token !== "string" ||
        !/^[0-9a-f-]{36}$/.test(owner.token) || !Number.isFinite(Date.parse(owner.createdAt)) ||
        !/^[a-f0-9]{64}$/.test(signed.mac ?? ""))
      throw new Error("Browser command lock has invalid owner identity; refusing to reclaim it");
    const expectedMac = createHmac("sha256", key).update(canonical(owner)).digest("hex");
    if (!timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(signed.mac, "hex")))
      throw new Error("Browser command lock owner signature is invalid; refusing to reclaim it");

    const actual = await captureProcessIdentity(owner.pid);
    if (actual && sameBrokerProcessIdentity(owner.process, actual)) return false;
    if (actual) {
      // PID reuse proves the recorded process incarnation is gone.
    } else {
      try {
        process.kill(owner.pid, 0);
        throw new Error("Browser command lock owner is alive but its identity cannot be verified");
      } catch (error) {
        if (error instanceof Error && error.message.includes("identity cannot be verified")) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("Cannot prove browser command lock owner is dead; refusing to reclaim it");
      }
    }

    // Rename to a unique quarantine name so only one waiter can take the stale
    // entry. Verify the moved bytes before deleting anything; restore unexpected
    // contents to the canonical path when it is still vacant.
    const quarantine = `${lockPath}.stale-${owner.token}-${randomUUID()}`;
    let latest;
    try { latest = await lstat(lockPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    if (latest.dev !== stat.dev || latest.ino !== stat.ino) return false;
    try { await rename(lockPath, quarantine); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    const moved = await readFile(quarantine, "utf8");
    if (moved !== raw) {
      try { await link(quarantine, lockPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await rm(quarantine, { force: true });
      return false;
    }
    await rm(quarantine, { force: true });
    return true;
  }

  private async releaseLock(lockPath: string, token: string): Promise<void> {
    const key = await this.signingKey();
    const raw = await readFile(lockPath, "utf8");
    const signed = JSON.parse(raw) as SignedBrokerLock;
    if (signed?.lock?.token !== token) throw new Error("Browser command lock ownership changed before release");
    const expectedMac = createHmac("sha256", key).update(canonical(signed.lock)).digest("hex");
    if (!timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(signed.mac, "hex")))
      throw new Error("Browser command lock signature changed before release");
    await rm(lockPath);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Unsafe browser command outbox directory");
  }

  private async signingKey(): Promise<Buffer> {
    this.keyPromise ??= (async () => {
      await this.ensureDirectory();
      try {
        const stat = await lstat(this.keyPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size !== 32)
          throw new Error("Unsafe browser command outbox signing key");
        return await readFile(this.keyPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const candidate = randomBytes(32);
      try {
        const handle = await open(this.keyPath, "wx", 0o600);
        try { await handle.writeFile(candidate); await handle.sync(); }
        finally { await handle.close(); }
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(this.keyPath);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size !== 32)
          throw new Error("Unsafe browser command outbox signing key");
        return await readFile(this.keyPath);
      }
    })();
    return await this.keyPromise;
  }

  private async read(commandId: string): Promise<CommandRecord | null> {
    let text: string;
    try { text = await readFile(this.path(commandId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (text.length > 16_384) throw new Error("Browser command outbox record exceeds capacity");
    let signed: SignedRecord;
    try { signed = JSON.parse(text) as SignedRecord; }
    catch { throw new Error("Malformed browser command outbox record"); }
    const record = signed?.record;
    if (!record || record.version !== 1 || !STATUS.has(record.status) ||
        record.command?.commandId !== commandId || !HEX.test(signed.mac ?? ""))
      throw new Error("Invalid browser command outbox record");
    validateCommand(record.command);
    const expected = createHmac("sha256", await this.signingKey()).update(canonical(record)).digest("hex");
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signed.mac, "hex")))
      throw new Error("Browser command outbox integrity check failed");
    return record;
  }

  private async require(commandId: string): Promise<CommandRecord> {
    const record = await this.read(commandId);
    if (!record) throw new Error("Browser command was not prepared");
    return record;
  }

  private async write(commandId: string, record: CommandRecord): Promise<void> {
    const path = this.path(commandId);
    const temp = `${path}.${randomUUID()}.tmp`;
    const key = await this.signingKey();
    const signed: SignedRecord = { record, mac: createHmac("sha256", key).update(canonical(record)).digest("hex") };
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(`${canonical(signed)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); }
      finally { await directory.close(); }
    } finally { await rm(temp, { force: true }); }
  }
}

function validateCommand(command: BrowserCommand): void {
  const purpose=command?.purpose??"worker_turn";
  const ownerValid=purpose==="worker_turn"
    ? command?.ownerFingerprint===undefined&&command?.ownerBindingSha256===undefined
    : purpose==="owner_wakeup"&&command?.workerId==="main_agent_owner"&&
      /^chat_[a-f0-9]{64}$/.test(command.ownerFingerprint??"")&&HEX.test(command.ownerBindingSha256??"");
  if (!command || !REPO.test(command.repo) || !Number.isSafeInteger(command.issue) || command.issue < 1 ||
      !ownerValid || !["worker_turn","owner_wakeup"].includes(purpose) ||
      !ID.test(command.workerId) || !Number.isSafeInteger(command.turn) || command.turn < 0 ||
      !ID.test(command.commandId) || !ID.test(command.runtimeIncarnation) || !ID.test(command.profileOwner) ||
      !ID.test(command.windowLease) || !ID.test(command.tabLease) || !ID.test(command.documentId) ||
      !(command.pr===null || (Number.isSafeInteger(command.pr) && command.pr > 0)) ||
      !HEX.test(command.reportTokenHash) || !HEX.test(command.graphSha256) ||
      !HEX.test(command.workerManifestSha256) || !HEX.test(command.authorizationMac) ||
      !Number.isSafeInteger(command.expiresAt) || command.expiresAt <= 0 ||
      !Number.isSafeInteger(command.navigationEpoch) || command.navigationEpoch < 0 ||
      (command.conversationId !== undefined && !ID.test(command.conversationId)) || !HEX.test(command.payloadSha256))
    throw new Error("Invalid browser command identity");
}

function sameBrokerProcessIdentity(
  expected: BrokerLockRecord["process"], actual: ProcessIdentity,
): boolean {
  return expected.pid === actual.pid && expected.startTime === actual.startTime &&
    expected.executable === actual.executable &&
    expected.commandLineSha256 === digest(actual.commandLine ?? "");
}
