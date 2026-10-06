import { setTimeout as delay } from "node:timers/promises";

export type ConnectorLifecycleStatus =
  | "starting"
  | "healthy"
  | "recovering"
  | "degraded"
  | "terminal_failed"
  | "stopped";

export interface ConnectorSupervisorState {
  status: ConnectorLifecycleStatus;
  restartAttempt: number;
  maxRestartAttempts: number;
  lastFailureAt?: string;
  lastFailureComponent?: string;
  lastExitCode?: number | null;
  lastExitSignal?: NodeJS.Signals | null;
  lastFailureMessage?: string;
}

export interface ConnectorAttempt<T> {
  ready: Promise<T>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(signal?: NodeJS.Signals): void;
}

export const CONNECTOR_RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

export async function runBoundedConnectorSupervisor<T>(options: {
  launch: () => Promise<ConnectorAttempt<T>>;
  onState: (state: ConnectorSupervisorState, ready?: T) => Promise<void> | void;
  onHealthy?: (ready: T) => Promise<void> | void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  stableResetMs?: number;
}): Promise<void> {
  const sleep = options.sleep ?? (async ms => { await delay(ms); });
  const now = options.now ?? Date.now;
  const stableResetMs = options.stableResetMs ?? 60_000;
  const maxRestartAttempts = CONNECTOR_RESTART_DELAYS_MS.length;
  let failures = 0;

  while (!options.signal?.aborted) {
    await options.onState({
      status: failures === 0 ? "starting" : "recovering",
      restartAttempt: failures,
      maxRestartAttempts,
    });

    const attempt = await options.launch();
    const abort = () => attempt.stop("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    let healthyAt: number | undefined;
    try {
      const ready = await attempt.ready;
      if (options.signal?.aborted) {
        attempt.stop("SIGTERM");
        return;
      }
      healthyAt = now();
      await options.onState({
        status: "healthy",
        restartAttempt: failures,
        maxRestartAttempts,
      }, ready);
      await options.onHealthy?.(ready);
      const exited = await attempt.exit;
      if (options.signal?.aborted) return;
      if (healthyAt !== undefined && now() - healthyAt >= stableResetMs) failures = 0;
      throw Object.assign(new Error("connector runtime exited unexpectedly"), {
        exitCode: exited.code,
        exitSignal: exited.signal,
      });
    } catch (error) {
      attempt.stop("SIGTERM");
      if (options.signal?.aborted) {
        attempt.stop("SIGTERM");
        return;
      }
      failures++;
      const detail = error as Error & { exitCode?: number | null; exitSignal?: NodeJS.Signals | null };
      if (failures > maxRestartAttempts) {
        await options.onState({
          status: "terminal_failed",
          restartAttempt: maxRestartAttempts,
          maxRestartAttempts,
          lastFailureAt: new Date(now()).toISOString(),
          lastFailureComponent: "runtime",
          lastExitCode: detail.exitCode,
          lastExitSignal: detail.exitSignal,
          lastFailureMessage: detail.message,
        });
        throw new Error("Connector restart budget exhausted.");
      }
      await options.onState({
        status: "recovering",
        restartAttempt: failures,
        maxRestartAttempts,
        lastFailureAt: new Date(now()).toISOString(),
        lastFailureComponent: "runtime",
        lastExitCode: detail.exitCode,
        lastExitSignal: detail.exitSignal,
        lastFailureMessage: detail.message,
      });
      await sleep(CONNECTOR_RESTART_DELAYS_MS[failures - 1]!);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  await options.onState({
    status: "stopped",
    restartAttempt: failures,
    maxRestartAttempts,
  });
}
