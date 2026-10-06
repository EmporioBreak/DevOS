// Per-run foreground owner. EOF retains the mutex until group cleanup finishes.
import { connector } from "./connector.js";
try {
  await connector("run", process.argv[2]!, process.stdin);
} catch (error) {
  process.stderr.write(
    `DevOS connector: ${error instanceof Error ? error.message : "runner failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  process.stdin.destroy();
}
