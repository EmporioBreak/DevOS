import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  executable: string;
  commandLine?: string;
}

export async function processExists(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function captureProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | null> {
  if (!(await processExists(pid))) return null;

  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTime = fields[19];
      const executable = await readlink(`/proc/${pid}/exe`);
      const commandLine = (await readFile(`/proc/${pid}/cmdline`))
        .toString("utf8")
        .replace(/\0+/g, " ")
        .trim();
      if (!startTime || !executable || !commandLine) return null;
      return { pid, startTime, executable, commandLine };
    } catch {
      return null;
    }
  }

  if (process.platform !== "darwin") return null;

  const [startTime, executable, commandLine] = await Promise.all([
    runPsField(pid, "lstart"),
    runPsField(pid, "comm"),
    runPsField(pid, "command"),
  ]);
  if (!startTime || !executable || !commandLine) return null;
  return { pid, startTime, executable, commandLine };
}

export function sameProcessIdentity(
  expected: ProcessIdentity,
  actual: ProcessIdentity,
): boolean {
  return (
    expected.pid === actual.pid &&
    expected.startTime === actual.startTime &&
    expected.executable === actual.executable &&
    expected.commandLine === actual.commandLine
  );
}

async function runPsField(
  pid: number,
  field: "lstart" | "comm" | "command",
): Promise<string | null> {
  return await new Promise(resolve => {
    const child = spawn("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      `${field}=`,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", () => finish(null));
    child.once("close", code => {
      finish(code === 0 && stdout.trim() ? stdout.trim() : null);
    });
  });
}
