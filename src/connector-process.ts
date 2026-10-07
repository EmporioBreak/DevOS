import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface ProcessUsage {
  rssBytes: number;
  cpuPercent: number;
}

export function safeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "SystemRoot", "LANG"])
    if (env[key]) out[key] = env[key];
  return out;
}

export function desktopCommand(root: string) {
  return {
    file: process.execPath,
    args: [
      join(root, "node_modules/@wonderwhy-er/desktop-commander/dist/index.js"),
      "--no-onboarding",
    ],
  };
}

/** Capture resource usage for one exact PID without reading its command line. */
export function captureProcessUsage(pid: number): ProcessUsage | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32")
    return undefined;
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "rss=", "-o", "%cpu="],
    {
      encoding: "utf8",
      timeout: 500,
      maxBuffer: 1_024,
      env: safeEnvironment(process.env),
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0 || result.error) return undefined;
  const [rssKb, cpuPercent] = result.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(rssKb) || !Number.isFinite(cpuPercent)) return undefined;
  return { rssBytes: Math.round(rssKb! * 1024), cpuPercent: cpuPercent! };
}
