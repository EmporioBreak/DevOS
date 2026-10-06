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
  onOutput?: (stdout: string) => void | Promise<void>;
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

      let stdout = "";
      let stderr = "";
      let completedEarly = false;
      let interrupted: NodeJS.Signals | undefined;
      const stopOwnedGroup = () => {
        if (child.pid === undefined) return;
        if (process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already gone. */ }
        }
        child.kill("SIGKILL");
      };
      const onInterrupt = (signal: NodeJS.Signals) => {
        interrupted = signal;
        stopOwnedGroup();
      };
      const onSigint = () => onInterrupt("SIGINT");
      const onSigterm = () => onInterrupt("SIGTERM");
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      const restoreSignals = () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
      let outputPending = Promise.resolve();
      let outputError: unknown;
      child.stdin.on("error", error => { stderr += `\nstdin: ${error.message}`; });
      child.stdin.end(stdin);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        const captured = stdout;
        outputPending = outputPending.then(() => options.onOutput?.(captured)).catch(error => {
          outputError = error;
          stopOwnedGroup();
        });
        if (!completedEarly && options.completeWhenOutput) {
          try {
            completedEarly = options.completeWhenOutput(stdout);
          } catch {
            completedEarly = false;
          }
          if (completedEarly) stopOwnedGroup();
        }
      });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", error => {
        restoreSignals();
        stopOwnedGroup();
        debugLog("process.error", { command, cwd, error: error.message, elapsedMs: Date.now() - startedAt });
        reject(error);
      });
      child.on("close", async (code, signal) => {
        restoreSignals();
        await outputPending;
        if (outputError) { reject(outputError); return; }
        if (interrupted) { reject(new Error(`Command interrupted by ${interrupted}`)); return; }
        const result = { exitCode: code ?? 1, stdout, stderr, signal, completedEarly };
        debugLog("process.end", { command, args, cwd, ...result, elapsedMs: Date.now() - startedAt });
        resolve(result);
      });
    });
  }
}
