import { once } from "node:events";
import type { ChildProcess } from "node:child_process";

/** Stop a test-owned child and prove it exited before deleting its state tree. */
export async function terminateOwnedChildAndWait(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (!child.kill("SIGTERM")) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw new Error("Could not signal the owned child process");
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Owned child did not exit before cleanup deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
