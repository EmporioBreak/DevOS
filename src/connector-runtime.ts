// Private gateway/ngrok/stdio group. The runner bounds shutdown for all descendants.
import { connectorRuntime } from "./connector.js";
try {
  await connectorRuntime(process.argv[2]!);
} catch (error) {
  process.send?.({
    failure: error instanceof Error ? error.message.slice(0, 512) : "runtime failed",
  });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
