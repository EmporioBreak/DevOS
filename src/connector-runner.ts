// Per-run foreground owner. EOF retains the mutex until group cleanup finishes.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { connector } from "./connector.js";

const root = process.argv[2]!;
const background = process.argv[3] === "--background";
const lifetime = background ? new PassThrough() : process.stdin;

try {
  await connector("run", root, lifetime);
} catch (error) {
  process.stderr.write(
    `DevOS connector: ${error instanceof Error ? error.message : "runner failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  if (background) {
    await rm(join(root, ".devos/connector/background.json"), { force: true });
    lifetime.destroy();
  } else {
    process.stdin.destroy();
  }
}
