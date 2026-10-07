import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { captureProcessIdentity, processExists, sameProcessIdentity, type ProcessIdentity } from "./process-identity.js";
import type { TaskRef } from "./workflow.js";

interface TaskLockState {
  repo: string;
  issue: number;
  pid: number;
  identity: ProcessIdentity;
  runId: string;
  startedAt: string;
}

export function taskLockPath(projectRoot: string, task: TaskRef): string {
  return join(
    projectRoot,
    ".devos",
    "locks",
    `${encodeURIComponent(task.repo)}-issue-${task.issue}.lock`,
  );
}

export async function acquireTaskLock(
  projectRoot: string,
  task: TaskRef,
): Promise<{ runId: string; release(): Promise<void> }> {
  const path = taskLockPath(projectRoot, task);
  await mkdir(dirname(path), { recursive: true });
  const runId = randomUUID();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      const identity = await captureProcessIdentity(process.pid);
      if (!identity) {
        await handle.close();
        await rm(path, { force: true });
        throw new Error("DevOS could not prove its own process identity");
      }
      const state: TaskLockState = {
        repo: task.repo,
        issue: task.issue,
        pid: process.pid,
        identity,
        runId,
        startedAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(state) + "\n", "utf8");
      await handle.close();
      return {
        runId,
        release: async () => {
          const current = await readTaskLock(path);
          if (current?.runId === runId && current.pid === process.pid) {
            await rm(path, { force: true });
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readTaskLock(path);
      if (!existing) {
        throw new Error(
          `Task #${task.issue} has an existing lock whose ownership cannot be validated; refusing to remove it automatically`,
        );
      }
      const live = await processExists(existing.pid);
      if (!live) {
        await rm(path, { force: true });
        continue;
      }
      const actual = await captureProcessIdentity(existing.pid);
      if (actual && !sameProcessIdentity(existing.identity, actual)) {
        await rm(path, { force: true });
        continue;
      }
      throw new Error(
        `Task #${task.issue} is already owned by DevOS process ${existing.pid}`,
      );
    }
  }

  throw new Error(`Could not acquire DevOS task lock for issue #${task.issue}`);
}

async function readTaskLock(path: string): Promise<TaskLockState | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as TaskLockState;
    if (
      typeof value?.repo !== "string" ||
      !Number.isSafeInteger(value?.issue) ||
      !Number.isSafeInteger(value?.pid) ||
      typeof value?.runId !== "string" ||
      typeof value?.startedAt !== "string" ||
      !value?.identity
    ) return null;
    return value;
  } catch {
    return null;
  }
}
