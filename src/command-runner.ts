import { spawn } from "node:child_process";
import { debugLog } from "./debug-log.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

export class LocalCommandRunner implements CommandRunner {
  async run(command: string, args: string[], cwd: string): Promise<CommandResult> {
    const startedAt = Date.now();
    debugLog("process.start", { command, args, cwd });
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", error => {
        debugLog("process.error", { command, cwd, error: error.message, elapsedMs: Date.now() - startedAt });
        reject(error);
      });
      child.on("close", (code, signal) => {
        const result = { exitCode: code ?? 1, stdout, stderr, signal };
        debugLog("process.end", { command, args, cwd, ...result, elapsedMs: Date.now() - startedAt });
        resolve(result);
      });
    });
  }
}
