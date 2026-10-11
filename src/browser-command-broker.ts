import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    let handle;
    const deadline = Date.now() + 5_000;
    while (!handle) {
      try { handle = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error("Browser command is concurrently locked or has an interrupted operation; refusing replay");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await operation(); }
    finally { await handle.close(); await rm(lockPath, { force: true }); }
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
