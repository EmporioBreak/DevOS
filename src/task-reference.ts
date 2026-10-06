import type { CommandResult, CommandRunner } from "./command-runner.js";
import type { TaskRef } from "./workflow.js";

export async function resolveTaskReference(
  task: TaskRef,
  projectRoot: string,
  runner: CommandRunner,
): Promise<TaskRef> {
  if (task.pr !== undefined) return task;

  let result: CommandResult;
  try {
    result = await runner.run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        task.repo,
        "--state",
        "all",
        "--search",
        `#${task.issue} in:body`,
        "--limit",
        "100",
        "--json",
        "number,body",
      ],
      projectRoot,
    );
  } catch {
    return task;
  }

  if (result.exitCode !== 0) return task;

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return task;
  }
  if (!Array.isArray(value)) return task;

  const repo = escapeRegExp(task.repo);
  const issueRef = new RegExp(
    `(?:^|[^A-Za-z0-9_-])(?:${repo})?#${task.issue}(?!\\d)`,
    "i",
  );
  const closingRef = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:${repo})?#${task.issue}(?!\\d)`,
    "i",
  );

  const matches = value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.number !== "number" ||
      !Number.isSafeInteger(record.number) ||
      record.number <= 0 ||
      typeof record.body !== "string" ||
      !issueRef.test(record.body)
    ) {
      return [];
    }
    return [{ number: record.number, closing: closingRef.test(record.body) }];
  });

  const closing = matches.filter(match => match.closing);
  const chosen =
    closing.length === 1
      ? closing[0]
      : closing.length === 0 && matches.length === 1
        ? matches[0]
        : undefined;

  return chosen ? { ...task, pr: chosen.number } : task;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
