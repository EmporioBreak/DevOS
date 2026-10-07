export type ConnectorBackendState =
  | "unknown"
  | "alive"
  | "suspect"
  | "stale/dead";

export interface ConnectorWatchdogSnapshot {
  state: ConnectorBackendState;
  lastBackendOkAt?: string;
  consecutiveMisses: number;
}

export interface ConnectorWatchdog {
  snapshot(): ConnectorWatchdogSnapshot;
  stop(): Promise<void>;
}

export function createConnectorWatchdog(options: {
  ping(timeoutMs: number): Promise<void>;
  onFailure(): void;
  initialSuccessAt: number;
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  now?: () => number;
}): ConnectorWatchdog {
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const failureThreshold = options.failureThreshold ?? 3;
  const now = options.now ?? Date.now;
  let lastBackendOkAt = options.initialSuccessAt;
  let consecutiveMisses = 0;
  let stopped = false;
  let failed = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (at: number) => {
    if (stopped || failed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runAttempt();
    }, Math.max(0, at - now()));
    timer.unref?.();
  };

  const runAttempt = async () => {
    if (stopped || failed || inFlight) return;
    inFlight = true;
    const startedAt = now();
    try {
      await options.ping(timeoutMs);
      if (stopped) return;
      lastBackendOkAt = now();
      consecutiveMisses = 0;
    } catch {
      if (stopped) return;
      consecutiveMisses++;
      if (consecutiveMisses >= failureThreshold) {
        failed = true;
        options.onFailure();
        return;
      }
    } finally {
      inFlight = false;
      if (!stopped && !failed) schedule(startedAt + intervalMs);
    }
  };

  schedule(options.initialSuccessAt + intervalMs);

  return {
    snapshot() {
      return {
        state: failed
          ? "stale/dead"
          : consecutiveMisses > 0
            ? "suspect"
            : "alive",
        lastBackendOkAt: new Date(lastBackendOkAt).toISOString(),
        consecutiveMisses,
      };
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      // The active ping is already bounded by its MCP request timeout. Do not
      // wait for it during shutdown; its completion checks `stopped` before it
      // can mutate health or report a late failure.
    },
  };
}
