/** Cancel a forwarded tool when its chat grant is revoked mid-call.
 * The upstream process may already have side effects; cancellation is
 * best-effort and must not be described as an atomic rollback.
 */
export function watchChatAccessRevocation(
  stillAuthorized: () => boolean,
  controller: AbortController,
  intervalMs = 1_000,
): () => void {
  const cancelIfRevoked = () => {
    try {
      if (!stillAuthorized() && !controller.signal.aborted)
        controller.abort(new Error("Chat access revoked during operation"));
    } catch {
      // If grant state is corrupt or temporarily unreadable, deny.
      if (!controller.signal.aborted)
        controller.abort(new Error("Cannot validate chat access"));
    }
  };
  const timer = setInterval(cancelIfRevoked, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
