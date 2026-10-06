import { spawn } from "node:child_process";
import { debugLog } from "./debug-log.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  completedEarly?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
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

      const stdoutBuffer = new BoundedOutputBuffer();
      const stderrBuffer = new BoundedOutputBuffer();
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
      child.stdin.on("error", error => { stderrBuffer.append(`\nstdin: ${error.message}`); });
      child.stdin.end(stdin);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer.append(chunk);
        const captured = stdoutBuffer.snapshot();
        outputPending = outputPending.then(() => options.onOutput?.(captured)).catch(error => {
          outputError = error;
          stopOwnedGroup();
        });
        if (!completedEarly && options.completeWhenOutput) {
          try {
            completedEarly = options.completeWhenOutput(captured);
          } catch {
            completedEarly = false;
          }
          if (completedEarly) stopOwnedGroup();
        }
      });
      child.stderr.on("data", (chunk: string) => { stderrBuffer.append(chunk); });
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
        const result = {
          exitCode: code ?? 1,
          stdout: stdoutBuffer.snapshot(),
          stderr: stderrBuffer.snapshot(),
          signal,
          completedEarly,
          stdoutTruncated: stdoutBuffer.truncated,
          stderrTruncated: stderrBuffer.truncated,
        };
        debugLog("process.end", { command, args, cwd, ...result, elapsedMs: Date.now() - startedAt });
        resolve(result);
      });
    });
  }
}


const OUTPUT_HEAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 1024 * 1024;
const OUTPUT_TRUNCATION_MARKER = Buffer.from("\n...[output truncated]...\n");

class BoundedOutputBuffer {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  get truncated(): boolean {
    return this.totalBytes > OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;
  }

  append(value: string): void {
    const chunk = Buffer.from(value);
    this.totalBytes += chunk.length;

    if (this.head.length < OUTPUT_HEAD_BYTES) {
      const remaining = OUTPUT_HEAD_BYTES - this.head.length;
      this.head = Buffer.concat([this.head, chunk.subarray(0, remaining)]);
    }

    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > OUTPUT_TAIL_BYTES) {
      this.tail = this.tail.subarray(this.tail.length - OUTPUT_TAIL_BYTES);
    }
  }

  snapshot(): string {
    if (!this.truncated) {
      if (this.totalBytes <= OUTPUT_HEAD_BYTES) return this.head.toString("utf8");
      const overlap = Math.max(0, OUTPUT_HEAD_BYTES + this.tail.length - this.totalBytes);
      return Buffer.concat([this.head, this.tail.subarray(overlap)]).toString("utf8");
    }
    return Buffer.concat([this.head, OUTPUT_TRUNCATION_MARKER, this.tail]).toString("utf8");
  }
}
