import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectorSupervisorState } from "./connector-supervisor.js";

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const RETAIN_DIAGNOSTIC_BYTES = 128 * 1024;

export function connectorDiagnosticRecord(state: ConnectorSupervisorState) {
  return {
    at: new Date().toISOString(),
    status: state.status,
    restartAttempt: state.restartAttempt,
    maxRestartAttempts: state.maxRestartAttempts,
    ...(state.lastFailureAt ? { lastFailureAt: state.lastFailureAt } : {}),
    ...(state.lastFailureComponent ? { lastFailureComponent: state.lastFailureComponent } : {}),
    ...(state.lastExitCode !== undefined ? { lastExitCode: state.lastExitCode } : {}),
    ...(state.lastExitSignal !== undefined ? { lastExitSignal: state.lastExitSignal } : {}),
    ...(state.lastFailureMessage ? { lastFailureMessage: state.lastFailureMessage.slice(0, 500) } : {}),
  };
}

export async function appendConnectorDiagnostic(
  root: string,
  state: ConnectorSupervisorState,
): Promise<void> {
  const path = join(root, ".devos", "logs", "connector.jsonl");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = Buffer.alloc(0);
  try {
    existing = Buffer.from(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const line = Buffer.from(JSON.stringify(connectorDiagnosticRecord(state)) + "\n");
  if (existing.length + line.length > MAX_DIAGNOSTIC_BYTES) {
    const tail = existing.subarray(Math.max(0, existing.length - RETAIN_DIAGNOSTIC_BYTES));
    const newline = tail.indexOf(0x0a);
    existing = newline >= 0 ? tail.subarray(newline + 1) : tail;
  }
  let body = Buffer.concat([existing, line]);
  if (body.length > MAX_DIAGNOSTIC_BYTES) {
    body = body.subarray(body.length - MAX_DIAGNOSTIC_BYTES);
  }
  await writeFile(path, body, { mode: 0o600 });
}
