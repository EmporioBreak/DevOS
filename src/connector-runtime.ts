// Private gateway/ngrok/stdio group. The runner bounds shutdown for all descendants.
import { connectorRuntime } from "./connector.js";
try {
  await connectorRuntime(process.argv[2]!);
} catch {
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect?.();
}
