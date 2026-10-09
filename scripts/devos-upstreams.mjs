import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const lockPath = resolve(dirname(self), "../config/devos-upstreams.lock.json");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
}).trim();

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) ||
      value.includes("\\") || value.split("/").some(p => !p || p === "." || p === ".."))
    throw new Error("Unsafe pinned upstream relative file path");
  return value;
}

export async function snapshot(root) {
  const raw = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  }).toString("utf8");
  const paths = raw.split("\0").filter(Boolean).sort();
  const hasher = createHash("sha256");
  const hashes = {};
  for (const relative of paths) {
    safeRelativePath(relative);
    const file = join(root, relative);
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Non-regular upstream file: ${relative}`);
    const hash = sha256(await readFile(file));
    hasher.update(relative).update("\0").update(hash).update("\0");
    hashes[relative] = hash;
  }
  return { fileCount: paths.length, snapshotSha256: hasher.digest("hex"), hashes };
}

export async function verifySource(source, root) {
  if (!/^[a-z][a-z0-9-]*$/.test(source.id) ||
      !/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9-]+\.git$/i.test(source.repository) ||
      !/^[0-9a-f]{40}$/.test(source.commit))
    throw new Error("Invalid upstream source manifest");
  const head = git(root, "rev-parse", "HEAD");
  if (head !== source.commit) throw new Error(`${source.id}: pinned Git revision mismatch`);
  const dirty = git(root, "status", "--porcelain", "--untracked-files=all");
  if (dirty) throw new Error(`${source.id}: pinned upstream snapshot is modified`);
  const state = await snapshot(root);
  if (state.fileCount !== source.fileCount || state.snapshotSha256 !== source.snapshotSha256)
    throw new Error(`${source.id}: SHA-256 snapshot integrity mismatch`);
  for (const [file, expected] of Object.entries(source.keyFiles ?? {})) {
    safeRelativePath(file);
    if (!/^[0-9a-f]{64}$/.test(expected) || state.hashes[file] !== expected)
      throw new Error(`${source.id}: key file integrity mismatch: ${file}`);
  }
  return { id: source.id, commit: head, fileCount: state.fileCount, snapshotSha256: state.snapshotSha256 };
}

export async function syncSource(source, root) {
  const target = join(root, source.id);
  if (existsSync(target)) return verifySource(source, target);
  const temp = join(root, `.${source.id}-install-${process.pid}`);
  if (existsSync(temp)) throw new Error("Refusing to overwrite existing staging install");
  const clone = spawnSync("git", ["clone", "--quiet", "--depth", "1", "--branch",
    source.tag, source.repository, temp], { encoding: "utf8", timeout: 120_000 });
  if (clone.status !== 0) {
    await rm(temp, { recursive: true, force: true });
    throw new Error(`${source.id}: public upstream clone failed`);
  }
  try {
    const report = await verifySource(source, temp);
    await rename(temp, target);
    return report;
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const [mode, flag, arg] = process.argv.slice(2);
  if (!["verify", "install"].includes(mode) ||
      (flag !== undefined && (flag !== "--root" || !arg)) ||
      (arg !== undefined && flag !== "--root"))
    throw new Error("Usage: node scripts/devos-upstreams.mjs <verify|install> [--root DIR]");
  const root = resolve(arg ?? process.env.DEVOS_UPSTREAM_ROOT ??
    join(homedir(), ".devos-staging", "upstream"));
  const manifest = JSON.parse(await readFile(lockPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.sources))
    throw new Error("Unsupported upstream manifest version");
  if (mode === "install") await mkdir(root, { recursive: true, mode: 0o700 });
  for (const source of manifest.sources) {
    const report = mode === "install"
      ? await syncSource(source, root)
      : await verifySource(source, join(root, source.id));
    process.stdout.write(`${report.id}: OK ${report.commit} (${report.fileCount} pinned files)\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  main().catch(error => { process.stderr.write(`Upstream verification failed: ${error.message}\n`); process.exitCode = 1; });
}
