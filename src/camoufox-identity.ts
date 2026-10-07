import { getRandomPreset } from "@camoufox/camoufox";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface CamoufoxIdentity {
  schema: 1;
  os: "macos" | "windows" | "linux";
  preset: Record<string, unknown>;
}

export const camoufoxIdentityDeps = {
  getRandomPreset,
};

export function camoufoxIdentityPath(profileDir: string): string {
  return join(dirname(profileDir), `${basename(profileDir)}.identity.json`);
}

function hostCamoufoxOs(): CamoufoxIdentity["os"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseIdentity(raw: string, path: string): CamoufoxIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Camoufox identity file at ${path}; refusing to rotate browser identity`);
  }
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    !["macos", "windows", "linux"].includes(String(value.os)) ||
    !isRecord(value.preset) ||
    Object.keys(value.preset).length === 0
  ) {
    throw new Error(`Invalid Camoufox identity file at ${path}; refusing to rotate browser identity`);
  }
  return value as unknown as CamoufoxIdentity;
}

async function readIdentity(path: string): Promise<CamoufoxIdentity | undefined> {
  try {
    return parseIdentity(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * One persistent DevOS browser profile owns one persistent Camoufox fingerprint.
 * The identity is created once and never silently regenerated: a corrupt file
 * fails closed so authenticated cookies are not reused under a new fingerprint.
 */
export async function loadOrCreateCamoufoxIdentity(
  profileDir: string,
): Promise<CamoufoxIdentity> {
  const path = camoufoxIdentityPath(profileDir);
  const existing = await readIdentity(path);
  if (existing) return existing;

  const os = hostCamoufoxOs();
  const preset = camoufoxIdentityDeps.getRandomPreset(os);
  if (!preset || !isRecord(preset)) {
    throw new Error(`Camoufox has no bundled fingerprint preset for ${os}`);
  }

  const created: CamoufoxIdentity = {
    schema: 1,
    os,
    preset: preset as unknown as Record<string, unknown>,
  };

  try {
    await writeFile(path, JSON.stringify(created, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readIdentity(path);
    if (!raced) throw new Error("Camoufox identity creation race did not produce an identity file");
    return raced;
  }
}
