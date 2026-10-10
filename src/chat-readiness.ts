export interface ReadinessSnapshot {
  conversationMatches: boolean;
  projectMatches: boolean;
  composerEnabled: boolean;
  sendVisible: boolean;
  sendEnabled: boolean;
  generating: boolean;
  blockingOverlay: boolean;
}

export interface ReadinessOptions {
  timeoutMs: number;
  intervalMs?: number;
  maxIntervalMs?: number;
  stableSamples?: number;
  requireSendEnabled?: boolean;
}

/** Read-only, bounded gate. A ready observation must repeat identically; unknown
 * or malformed observations fail closed. */
export async function waitForStableReadiness(
  observe: () => Promise<ReadinessSnapshot>,
  options: ReadinessOptions,
): Promise<ReadinessSnapshot> {
  const { timeoutMs, intervalMs = 250, maxIntervalMs = intervalMs, stableSamples = 2, requireSendEnabled = true } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
      !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < intervalMs ||
      !Number.isSafeInteger(stableSamples) || stableSamples < 2) {
    throw new Error("Invalid chat readiness wait bounds");
  }
  const deadline = Date.now() + timeoutMs;
  let previous: string | undefined;
  let consecutive = 0;
  let delayMs = intervalMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: ReadinessSnapshot;
    try {
      snapshot = await Promise.race([
        observe(),
        new Promise<never>((_, reject) => {
          observationTimer = setTimeout(() => reject(new Error("Readiness observation exceeded its bounded deadline")), remaining);
        }),
      ]);
    } finally { if (observationTimer) clearTimeout(observationTimer); }
    const valid = snapshot.conversationMatches && snapshot.projectMatches &&
      snapshot.composerEnabled && snapshot.sendVisible && (!requireSendEnabled || snapshot.sendEnabled) &&
      !snapshot.generating && !snapshot.blockingOverlay;
    if (!valid) {
      previous = undefined;
      consecutive = 0;
      delayMs = Math.min(maxIntervalMs, delayMs * 2);
    } else {
      const encoded = JSON.stringify(snapshot);
      consecutive = encoded === previous ? consecutive + 1 : 1;
      previous = encoded;
      if (consecutive >= stableSamples) return snapshot;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("Chat did not become stably ready before the bounded readiness deadline");
}
