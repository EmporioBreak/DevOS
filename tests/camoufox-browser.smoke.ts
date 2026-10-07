/** Opt-in host smoke: npx @camoufox/camoufox fetch && npx tsx tests/camoufox-browser.smoke.ts */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Camoufox, getRandomPreset } from "@camoufox/camoufox";
import type { BrowserContext } from "playwright-core";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { profileProcesses } from "../src/owned-browser-process.js";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devos-camoufox-smoke-"));
const ownedProfile = join(root, "owned");
const controlProfile = join(root, "control");
const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

const executor = new ChatGptBrowserExecutor({
  projectUrl: "https://chatgpt.com/",
  profileDir: ownedProfile,
  headless: true,
}, 2_000);

let control: BrowserContext | undefined;
try {
  const controlPreset = getRandomPreset(os);
  assert.ok(controlPreset, `Camoufox has a bundled preset for ${os}`);
  control = await Camoufox({
    user_data_dir: controlProfile,
    persistent_context: true,
    fingerprint_preset: controlPreset,
    headless: true,
    timeout: 15_000,
  });

  const owned = await (
    executor as unknown as { getContext(timeout: number): Promise<BrowserContext> }
  ).getContext(15_000);

  const ownedPage = owned.pages()[0] ?? await owned.newPage();
  const controlPage = control.pages()[0] ?? await control.newPage();
  await ownedPage.goto("data:text/html,<title>DevOS owned Camoufox</title>");
  await controlPage.goto("data:text/html,<title>DevOS control Camoufox</title>");
  assert.equal(await ownedPage.evaluate(() => 6 * 7), 42);
  assert.equal(await controlPage.evaluate(() => 7 * 6), 42);

  const ownedRoots = await profileProcesses(ownedProfile);
  const controlRoots = await profileProcesses(controlProfile);
  assert.equal(ownedRoots.length, 1, "exactly one real owned Camoufox root must be detected");
  assert.equal(controlRoots.length, 1, "exactly one real control Camoufox root must be detected");

  if (process.platform === "darwin" || process.platform === "linux") {
    const { stdout } = await execute("ps", ["-axo", "pid=,lstart=,command="], {
      timeout: 1_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const relevant = stdout
      .split("\n")
      .filter(line => line.includes(ownedProfile) || line.includes(controlProfile));
    console.log(JSON.stringify({ processTable: relevant }));
  }

  Object.defineProperty(owned, "close", {
    configurable: true,
    value: () => new Promise<void>(() => {}),
  });

  await executor.close();

  assert.equal((await profileProcesses(ownedProfile)).length, 0, "fallback kills the exact owned browser");
  assert.equal((await profileProcesses(controlProfile)).length, 1, "fallback leaves the control browser alive");
  assert.equal(await controlPage.evaluate(() => 21 * 2), 42, "control browser still executes JavaScript");

  console.log(JSON.stringify({
    engine: "camoufox",
    persistent: true,
    ownedCleanupFallback: true,
    controlSurvived: true,
  }));
} finally {
  await control?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
