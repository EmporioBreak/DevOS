import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunState } from "./orchestrator.js";

function markerPath(projectRoot: string, issue: number): string {
  return join(projectRoot, ".devos", "completed", String(issue));
}

export async function isTaskCompleted(
  projectRoot: string,
  issue: number,
): Promise<boolean> {
  try {
    await access(markerPath(projectRoot, issue));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function markTaskCompleted(
  projectRoot: string,
  issue: number,
): Promise<void> {
  const path = markerPath(projectRoot, issue);
  await mkdir(join(projectRoot, ".devos", "completed"), { recursive: true });
  await writeFile(path, "completed\n", "utf8");
}

export async function clearTaskCompleted(
  projectRoot: string,
  issue: number,
): Promise<void> {
  await rm(markerPath(projectRoot, issue), { force: true });
}

export function isTerminallyApproved(state: RunState): boolean {
  return state.ownerReviewPending !== true;
}

export async function recordTaskCompletion(
  projectRoot: string,
  workflowIssue: number,
  state: RunState,
): Promise<void> {
  if (isTerminallyApproved(state)) {
    await markTaskCompleted(
      projectRoot,
      state.task?.issue ?? workflowIssue,
    );
  }
}
