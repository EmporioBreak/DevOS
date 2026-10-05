import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState, StateStore } from "./orchestrator.js";

export class JsonStateStore implements StateStore {
  readonly path: string;

  constructor(projectRoot: string) {
    this.path = join(projectRoot, ".devos", "state.json");
  }

  async load(): Promise<RunState | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      const value: unknown = JSON.parse(raw);
      return validateState(value);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async save(state: RunState): Promise<void> {
    const valid = validateState(state);
    await mkdir(dirname(this.path), { recursive: true });

    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(valid, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.path);
  }
}

function validateState(value: unknown): RunState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid DevOS state");
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.currentWorkerId !== "string" ||
    !record.currentWorkerId.trim() ||
    typeof record.completedRuns !== "number" ||
    !Number.isSafeInteger(record.completedRuns) ||
    record.completedRuns < 0
  ) {
    throw new Error("Invalid DevOS state");
  }

  return {
    currentWorkerId: record.currentWorkerId,
    completedRuns: record.completedRuns,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
