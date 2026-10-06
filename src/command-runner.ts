import { spawn } from "node:child_process";
import { debugLog } from "./debug-log.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  completedEarly?: boolean;
}

export interface CommandRunOptions {
  completeWhenOutput?: (stdout: string) => boolean;
}

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    cwd: string,
    stdin?: string,
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}

export class LocalCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    cwd: string,
    stdin?: string,
    options: CommandRunOptions = {},
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    debugLog("process.start", { command, args, cwd, stdin: stdin === undefined ? "ignored" : "provided" });
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      child.stdin.end(stdin);

      let stdout = "";
      let stderr = "";
      let completedEarly = false;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (!completedEarly && options.completeWhenOutput) {
          try {
            completedEarly = options.completeWhenOutput(stdout);
          } catch {
            completedEarly = false;
          }
          if (
            completedEarly &&
            child.pid !== undefined &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            if (process.platform === "win32") child.kill("SIGKILL");
            else {
              try { process.kill(-child.pid, "SIGKILL"); }
              catch { /* The direct child is still signalled below. */ }
              child.kill("SIGKILL");
            }
          }
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", error => {
        debugLog("process.error", { command, cwd, error: error.message, elapsedMs: Date.now() - startedAt });
        reject(error);
      });
      child.on("close", (code, signal) => {
        const result = { exitCode: code ?? 1, stdout, stderr, signal, completedEarly };
        debugLog("process.end", { command, args, cwd, ...result, elapsedMs: Date.now() - startedAt });
        resolve(result);
      });
    });
  }
}
