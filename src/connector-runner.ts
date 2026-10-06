// Per-run foreground owner. Background mode provides bounded recovery.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { connector } from "./connector.js";

const root = process.argv[2]!;
const background = process.argv[3] === "--background";
const lifetime = background ? new PassThrough() : process.stdin;
const dir = join(root, ".devos/connector");
let stopping = false;
const stop = () => {
  stopping = true;
  if (background) lifetime.destroy();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function atomicJson(name: string, value: unknown) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, name);
  const tmp = target + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await rename(tmp, target);
}

async function runBackground() {
  const backoff = [500, 1500, 4000];
  let last = "connector runtime failed";
  for (let attempt = 0; attempt <= backoff.length && !stopping; attempt++) {
    try {
      await atomicJson("supervisor.json", {
        version: 1,
        status: attempt ? "recovering" : "starting",
        attempt,
        updatedAt: new Date().toISOString(),
      });
      await connector("run", root, lifetime);
      if (stopping) return;
      last = "connector runtime exited unexpectedly";
    } catch (error) {
      last = error instanceof Error ? error.message : "connector runtime failed";
    }
    if (stopping) return;
    if (attempt === backoff.length) break;
    await atomicJson("diagnostic.json", {
      version: 1,
      layer: "supervisor",
      status: "recovering",
      attempt: attempt + 1,
      reason: last.slice(0, 512),
      at: new Date().toISOString(),
    });
    await delay(backoff[attempt]!);
  }
  if (!stopping) {
    await atomicJson("supervisor.json", {
      version: 1,
      status: "failed",
      attempts: backoff.length + 1,
      updatedAt: new Date().toISOString(),
    });
    await atomicJson("diagnostic.json", {
      version: 1,
      layer: "supervisor",
      status: "failed",
      reason: last.slice(0, 512),
      at: new Date().toISOString(),
    });
    process.exitCode = 1;
  }
}

try {
  if (background) await runBackground();
  else await connector("run", root, lifetime);
} catch (error) {
  process.stderr.write(
    `DevOS connector: ${error instanceof Error ? error.message : "runner failed"}\n`,
  );
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  if (background) {
    if (stopping) {
      await rm(join(dir, "supervisor.json"), { force: true });
      await rm(join(dir, "background.json"), { force: true });
    }
    lifetime.destroy();
  } else {
    process.stdin.destroy();
  }
}
