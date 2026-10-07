import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectorSupervisorState } from "./connector-supervisor.js";

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const RETAIN_DIAGNOSTIC_BYTES = 128 * 1024;

export function desktopCommanderDiagnosticRecord(input: {
  reason: string;
  runtimePid: number;
  publicSessionCount: number;
  activeForwardedRequestCount: number;
  snapshot: {
    state: string;
    consecutiveMisses: number;
    lastBackendOkAt?: string;
    pid?: number;
    processStartedAt?: string;
    activeRequestCount: number;
    protocolErrorCount: number;
    rssBytes?: number;
    cpuPercent?: number;
    notificationCounts: Record<string, number>;
    recentRequests: Array<{ timestamp: string; method: string; durationMs: number; status: string }>;
  };
}) {
  const { snapshot } = input;
  return {
    at: new Date().toISOString(),
    event: "desktop_commander_disconnect",
    reason: input.reason.slice(0, 100),
    runtimePid: input.runtimePid,
    publicSessionCount: input.publicSessionCount,
    activeForwardedRequestCount: input.activeForwardedRequestCount,
    backend: {
      state: snapshot.state,
      consecutiveMisses: snapshot.consecutiveMisses,
      ...(snapshot.lastBackendOkAt ? { lastBackendOkAt: snapshot.lastBackendOkAt } : {}),
      ...(snapshot.pid ? { pid: snapshot.pid } : {}),
      ...(snapshot.processStartedAt ? { processStartedAt: snapshot.processStartedAt } : {}),
      activeRequestCount: snapshot.activeRequestCount,
      protocolErrorCount: snapshot.protocolErrorCount,
      ...(snapshot.rssBytes !== undefined ? { rssBytes: snapshot.rssBytes } : {}),
      ...(snapshot.cpuPercent !== undefined ? { cpuPercent: snapshot.cpuPercent } : {}),
      notificationCounts: Object.fromEntries(Object.entries(snapshot.notificationCounts).slice(0, 16)),
      recentRequests: snapshot.recentRequests.slice(-50).map((event) => ({
        timestamp: event.timestamp,
        method: event.method.slice(0, 80),
        durationMs: event.durationMs,
        status: event.status,
      })),
    },
  };
}

export async function appendDesktopCommanderDiagnostic(root: string, input: Parameters<typeof desktopCommanderDiagnosticRecord>[0]): Promise<void> {
  const path = join(root, ".devos", "logs", "connector.jsonl");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existing = Buffer.alloc(0);
  try { existing = Buffer.from(await readFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const line = Buffer.from(JSON.stringify(desktopCommanderDiagnosticRecord(input)) + "\n");
  if (existing.length + line.length > MAX_DIAGNOSTIC_BYTES) {
    const tail = existing.subarray(Math.max(0, existing.length - RETAIN_DIAGNOSTIC_BYTES));
    const newline = tail.indexOf(0x0a);
    existing = newline >= 0 ? tail.subarray(newline + 1) : tail;
  }
  await writeFile(path, Buffer.concat([existing, line]), { mode: 0o600 });
}

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
