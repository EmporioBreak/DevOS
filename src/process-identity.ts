import { spawn } from "node:child_process";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  executable: string;
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

  if (process.platform !== "darwin") {
    return {
      pid,
      startTime: "unsupported-platform",
      executable: "unsupported-platform",
    };
  }

  const output = await runPs(pid);
  if (!output) return null;
  const separator = output.indexOf("\t");
  if (separator <= 0) return null;
  const startTime = output.slice(0, separator).trim();
  const executable = output.slice(separator + 1).trim();
  if (!startTime || !executable) return null;
  return { pid, startTime, executable };
}

export function sameProcessIdentity(
  expected: ProcessIdentity,
  actual: ProcessIdentity,
): boolean {
  return (
    expected.pid === actual.pid &&
    expected.startTime === actual.startTime &&
    expected.executable === actual.executable
  );
}

async function runPs(pid: number): Promise<string | null> {
  return await new Promise(resolve => {
    const child = spawn("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "lstart=",
      "-o",
      "comm=",
    ], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.once("error", () => resolve(null));
    child.once("close", code => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const line = stdout.trim();
      if (!line) {
        resolve(null);
        return;
      }
      const match = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(line);
      resolve(match ? `${match[1]}\t${match[2]}` : null);
    });
  });
}
