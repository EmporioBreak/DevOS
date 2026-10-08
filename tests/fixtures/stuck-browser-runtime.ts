/** Standalone fixture for checking that a successfully acknowledged task-close
 * also terminates its idle detached runtime process. Never opens ChatGPT. */
import { startSharedBrowserServer } from "../../src/shared-browser-runtime.js";
import type { ChatGptBrowserExecutor } from "../../src/chatgpt-browser-executor.js";

const [marker, socket, metadata] = process.argv.slice(2);
if (marker !== "--devos-browser-runtime" || !socket || !metadata) {
  throw new Error("Invalid test runtime fixture");
}
const executor = {
  async close() { /* Firefox window already closed, worker runtime still alive. */ },
  async run() { return { text: "" }; },
} as unknown as ChatGptBrowserExecutor;
await startSharedBrowserServer(socket, metadata, executor);
// A separate uncaught handle intentionally survives socket close. On SIGTERM
// the real server's handler cleans up, but this no-op keeps the process alive,
// forcing the ownership-verified SIGKILL fallback.
setInterval(() => {}, 10_000);
process.on("SIGTERM", () => {});
process.stdout.write("IDLE_RUNTIME_READY\\n");
