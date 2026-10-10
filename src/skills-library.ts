import { createHash } from "node:crypto";
import { readdir, readFile, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type SkillKind = "upstream" | "adapted" | "local";
export type SkillScope = "global" | "project" | "role" | "task";

export interface SkillSource {
  kind: SkillKind;
  /** Set only for upstream: exact source from config/devos-upstreams.lock.json. */
  upstreamId?: string;
  commit?: string;
  /** Path relative to the original pinned upstream or DevOS repository. */
  directory: string;
  /** For adapted copies only; never represents upstream bytes. */
  derivedFrom?: string;
  /** Reference URL, not an execution/download location. */
  sourceUrl: string;
  license: string;
}
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  source: SkillSource;
  entrypoint: "SKILL.md";
  /** Every regular file, including all subdirectory resources, must be pinned. */
  files: Record<string, string>;
  requires: string[];
  conflicts: string[];
  scopes: SkillScope[];
}
export interface SkillLibrary {
  version: 1;
  skills: SkillDefinition[];
}
export interface SkillRoots {
  projectRoot: string;
  upstreamRoot: string;
  upstreamPins: Record<string, string>;
}

const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const digestPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function validRelative(v: unknown, label: string): string {
  if (typeof v !== "string" || !v || isAbsolute(v) ||
      v.includes("\\") || v.includes("\0") ||
      v.split("/").some(segment => !segment || segment === "." || segment === ".."))
    throw new Error(`${label}: unsafe relative path`);
  return v;
}

function safeId(v: unknown, label: string): string {
  if (typeof v !== "string" || !idPattern.test(v))
    throw new Error(`${label} must be lowercase kebab-case`);
  return v;
}

function stringList(v: unknown, label: string): string[] {
  if (!Array.isArray(v) || v.some(x => typeof x !== "string"))
    throw new Error(`${label} must be a string array`);
  if (new Set(v).size !== v.length) throw new Error(`${label} contains duplicates`);
  return v;
}

function validateSkill(entry: unknown): SkillDefinition {
  if (!isRecord(entry)) throw new Error("Invalid skill");
  const allowed = new Set([
    "id", "name", "description", "version", "source",
    "entrypoint", "files", "requires", "conflicts", "scopes",
  ]);
  if (Object.keys(entry).some(k => !allowed.has(k))) throw new Error("Unknown skill fields");
  const id = safeId(entry.id, "Skill id");
  if (typeof entry.name !== "string" || !entry.name.trim() ||
      typeof entry.description !== "string" || !entry.description.trim() ||
      typeof entry.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(entry.version))
    throw new Error(`${id}: skill identity/version missing`);
  if (entry.entrypoint !== "SKILL.md") throw new Error(`${id}: SKILL.md required`);
  if (!isRecord(entry.source)) throw new Error(`${id}: invalid source`);
  const src = entry.source;
  if (Object.keys(src).some(k => !["kind", "upstreamId", "commit", "directory", "derivedFrom", "sourceUrl", "license"].includes(k)) ||
      !["upstream", "adapted", "local"].includes(String(src.kind)))
    throw new Error(`${id}: invalid source kind/fields`);
  const directory = validRelative(src.directory, `${id} source`);
  if (typeof src.sourceUrl !== "string" ||
      !/^https:\/\/[^\s/@]+[^\s]*$/.test(src.sourceUrl) ||
      typeof src.license !== "string" || !/^[A-Za-z0-9.+-]{2,64}$/.test(src.license))
    throw new Error(`${id}: source URL or license is invalid`);
  let source: SkillSource;
  if (src.kind === "upstream") {
    const upstreamId = safeId(src.upstreamId, "Upstream id");
    if (typeof src.commit !== "string" || !commitPattern.test(src.commit) ||
        src.derivedFrom !== undefined)
      throw new Error(`${id}: pinned upstream commit required`);
    source = { kind: "upstream", upstreamId, commit: src.commit, directory,
      sourceUrl: src.sourceUrl, license: src.license };
  } else {
    if (src.upstreamId !== undefined || src.commit !== undefined ||
        (src.kind === "adapted" &&
          (typeof src.derivedFrom !== "string" || !src.derivedFrom.trim())) ||
        (src.kind === "local" && src.derivedFrom !== undefined))
      throw new Error(`${id}: original and adapted source metadata must stay separate`);
    source = { kind: src.kind as "adapted" | "local", directory,
      sourceUrl: src.sourceUrl, license: src.license,
      ...(src.kind === "adapted" ? { derivedFrom: src.derivedFrom as string } : {}) };
  }
  if (!isRecord(entry.files) || Object.keys(entry.files).length === 0 ||
      !Object.prototype.hasOwnProperty.call(entry.files, "SKILL.md"))
    throw new Error(`${id}: no complete SKILL.md manifest`);
  const files: Record<string, string> = {};
  for (const [name, digest] of Object.entries(entry.files)) {
    const key = validRelative(name, `${id} file`);
    if (!digestPattern.test(String(digest)))
      throw new Error(`${id}: invalid SHA-256 for ${key}`);
    files[key] = digest as string;
  }
  const requires = stringList(entry.requires, `${id} requirements`)
    .map(v => safeId(v, "Required skill"));
  const conflicts = stringList(entry.conflicts, `${id} conflicts`)
    .map(v => safeId(v, "Conflicting skill"));
  if (requires.includes(id) || conflicts.includes(id))
    throw new Error(`${id}: skill cannot require or conflict with itself`);
  const scopes = stringList(entry.scopes, `${id} scopes`) as SkillScope[];
  if (!scopes.length || scopes.some(s => !["global", "project", "role", "task"].includes(s)))
    throw new Error(`${id}: invalid skill scope`);
  return {
    id, name: entry.name, description: entry.description,
    version: entry.version, source, entrypoint: "SKILL.md",
    files, requires, conflicts, scopes,
  };
}

export function parseSkillLibrary(data: unknown): SkillLibrary {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.skills) ||
      Object.keys(data).some(k => !["version", "skills"].includes(k)))
    throw new Error("Unsupported Skills Library format");
  const skills = data.skills.map(validateSkill);
  const ids = new Set<string>();
  for (const skill of skills) {
    if (ids.has(skill.id)) throw new Error(`Duplicate skill id ${skill.id}`);
    ids.add(skill.id);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const byId = new Map(skills.map(s => [s.id, s]));
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Cyclic skill dependency: ${id}`);
    if (visited.has(id)) return;
    const skill = byId.get(id);
    if (!skill) throw new Error(`Missing required skill: ${id}`);
    visiting.add(id);
    for (const dep of skill.requires) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  return { version: 1, skills };
}

/** Compute digest for all files; untracked assets are as important as SKILL.md. */
export async function snapshotSkillDirectory(directory: string): Promise<Record<string, string>> {
  const root = await realpath(directory);
  const files: Record<string, string> = {};
  async function walk(path: string, prefix: string): Promise<void> {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${item.name}` : item.name;
      validRelative(next, "Skill asset");
      const absolute = join(path, item.name);
      const kind = await lstat(absolute);
      if (kind.isSymbolicLink()) throw new Error(`Symlink in pinned skill: ${next}`);
      if (kind.isDirectory()) await walk(absolute, next);
      else if (kind.isFile())
        files[next] = createHash("sha256").update(await readFile(absolute)).digest("hex");
      else throw new Error(`Nonregular pinned skill asset: ${next}`);
    }
  }
  await walk(root, "");
  if (!files["SKILL.md"]) throw new Error("Missing SKILL.md");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export async function verifySkillFiles(skill: SkillDefinition, roots: SkillRoots): Promise<string> {
  const s = validateSkill(skill);
  const base = s.source.kind === "upstream"
    ? join(roots.upstreamRoot, s.source.upstreamId!)
    : roots.projectRoot;
  if (s.source.kind === "upstream" &&
      roots.upstreamPins[s.source.upstreamId!] !== s.source.commit)
    throw new Error(`${s.id}: upstream revision does not match locked repository`);
  const realBase = await realpath(base);
  const realDirectory = await realpath(join(realBase, s.source.directory));
  const delta = relative(realBase, realDirectory);
  if (!delta || delta === ".." || delta.startsWith(".." + sep) || isAbsolute(delta))
    throw new Error(`${s.id}: skill source escapes its trust root`);
  const actual = await snapshotSkillDirectory(realDirectory);
  const names = Object.keys(actual);
  if (names.length !== Object.keys(s.files).length ||
      names.some(name => actual[name] !== s.files[name]))
    throw new Error(`${s.id}: skill file integrity/manifest drift`);
  return realDirectory;
}

export async function readPinnedSkillResource(
  skill: SkillDefinition, resource: string, roots: SkillRoots,
): Promise<Buffer> {
  const name = validRelative(resource, "Skill resource");
  if (!Object.prototype.hasOwnProperty.call(skill.files, name))
    throw new Error("Skill resource not declared in pinned manifest");
  const directory = await verifySkillFiles(skill, roots);
  const full = await realpath(join(directory, name));
  const delta = relative(directory, full);
  if (!delta || delta === ".." || delta.startsWith(".." + sep) || isAbsolute(delta))
    throw new Error("Skill resource escapes its pinned directory");
  const content = await readFile(full);
  const actualDigest = createHash("sha256").update(content).digest("hex");
  if (actualDigest !== skill.files[name]) throw new Error("Skill resource changed during read");
  return content;
}

export function registerSkill(library: SkillLibrary, candidate: SkillDefinition): SkillLibrary {
  const existing = parseSkillLibrary(library);
  const proposed = validateSkill(candidate);
  if (existing.skills.some(s => s.id === proposed.id))
    throw new Error(`Skill id already registered: ${proposed.id}`);
  return parseSkillLibrary({ version: 1, skills: [...existing.skills, proposed] });
}

export function previewSkillUpdate(before: SkillDefinition, after: SkillDefinition) {
  const old = validateSkill(before), next = validateSkill(after);
  if (old.id !== next.id) throw new Error("A skill update cannot rename its identity");
  if (old.version === next.version && JSON.stringify(old) !== JSON.stringify(next))
    throw new Error("Modified skill contents require an explicit version bump");
  const versionParts = (value: string) => value.split(/[+-]/, 1)[0]!.split(".").map(Number);
  const left = versionParts(old.version), right = versionParts(next.version);
  for (let i = 0; i < 3; i++) {
    if (right[i]! < left[i]!) throw new Error("Skill version downgrade is not allowed");
    if (right[i]! > left[i]!) break;
  }
  const names = new Set([...Object.keys(old.files), ...Object.keys(next.files)]);
  return {
    id: old.id,
    oldVersion: old.version,
    newVersion: next.version,
    /** Review this exact before/after state before applying a replacement. */
    reviewFingerprint: createHash("sha256").update(
      JSON.stringify({ before: old, after: next }),
    ).digest("hex"),
    added: [...names].filter(name => !old.files[name]).sort(),
    removed: [...names].filter(name => !next.files[name]).sort(),
    changed: [...names].filter(name =>
      !!old.files[name] && !!next.files[name] && old.files[name] !== next.files[name]).sort(),
  };
}

/** Apply only the exact before/after state that the Main Agent has reviewed. */
export function applyReviewedSkillUpdate(
  library: SkillLibrary,
  replacement: SkillDefinition,
  reviewedFingerprint: string,
): SkillLibrary {
  const existing = parseSkillLibrary(library);
  const position = existing.skills.findIndex(item => item.id === replacement.id);
  if (position < 0) throw new Error("Cannot update an unregistered skill");
  const original = existing.skills[position]!;
  const next = validateSkill(replacement);
  if (next.version === original.version) throw new Error("Updated skill needs a new version");
  const preview = previewSkillUpdate(original, next);
  if (!digestPattern.test(reviewedFingerprint) ||
      preview.reviewFingerprint !== reviewedFingerprint)
    throw new Error("Skill update does not match approved review fingerprint");
  const skills = [...existing.skills];
  skills[position] = next;
  return parseSkillLibrary({ version: 1, skills });
}

/** Read-only inventory; availability does not authorize executing a skill. */
export async function listSkillAvailability(library: SkillLibrary, roots: SkillRoots):
  Promise<Array<{ id: string; version: string; kind: SkillKind;
    status: "installed" | "unavailable" | "integrity_failed" }>> {
  const catalog = parseSkillLibrary(library);
  return Promise.all(catalog.skills.map(async skill => {
    let status: "installed" | "unavailable" | "integrity_failed";
    try {
      await verifySkillFiles(skill, roots);
      status = "installed";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      status = code === "ENOENT" ? "unavailable" : "integrity_failed";
    }
    return { id: skill.id, version: skill.version, kind: skill.source.kind, status };
  }));
}
