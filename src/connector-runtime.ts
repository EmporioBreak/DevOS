// Private gateway/ngrok/stdio group. The runner bounds shutdown for all descendants.
import { connectorRuntime } from "./connector.js";
try {
  await connectorRuntime(process.argv[2]!);
} catch (error) {
  const detail = error as Error & { component?: string };
  if (process.send) {
    await new Promise<void>(resolve => {
      process.send!(
        {
          failure: {
            component: detail.component ?? "runtime",
            message: detail instanceof Error ? detail.message.slice(0, 500) : "connector runtime failed",
          },
        },
        () => resolve(),
      );
    });
  }
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
