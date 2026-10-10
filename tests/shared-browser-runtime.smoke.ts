import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Camoufox, getRandomPreset } from "@camoufox/camoufox";
import type { BrowserContext } from "playwright-core";
import { ChatGptBrowserExecutor } from "../src/chatgpt-browser-executor.js";
import { profileProcesses } from "../src/owned-browser-process.js";
import {
  browserRuntimePaths,
  closeSharedBrowserRuntime,
  startSharedBrowserServer,
} from "../src/shared-browser-runtime.js";

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "--runtime-child") {
  const [root, socketPath, metadataPath, profileDir, repo, issueText] = process.argv.slice(3);
  const task = { repo, issue: Number(issueText) };
  if (!root || !socketPath || !metadataPath || !profileDir || !repo || !Number.isSafeInteger(task.issue)) {
    throw new Error("missing shared-browser smoke child args");
  }
  const executor = new ChatGptBrowserExecutor({
    projectUrl: "https://chatgpt.com/",
    profileDir,
    headless: true,
  }, 2_000, async browserRoot => {
    const current = JSON.parse(await readFile(metadataPath, "utf8"));
    const temp = metadataPath + ".update";
    await writeFile(temp, JSON.stringify({ ...current, browserRoot, profileDir }), { mode: 0o600 });
    await rename(temp, metadataPath);
  });
  await startSharedBrowserServer(socketPath, metadataPath, executor);
  const context = await (
    executor as unknown as { getContext(timeout: number): Promise<BrowserContext> }
  ).getContext(15_000);
  const page = await (executor as unknown as { getWorkerPage(request: { task: typeof task; workerId: string }, context: BrowserContext): Promise<import("playwright-core").Page> })
    .getWorkerPage({ task, workerId: "smoke" }, context);
  await page.goto("data:text/html,<title>shared runtime child</title>");
  const js = await page.evaluate(() => 6 * 7);
  Object.defineProperty(context, "close", {
    configurable: true,
    value: () => new Promise<void>(() => {}),
  });
  process.stdout.write(JSON.stringify({ ready: true, js, pid: process.pid }) + "\n");
} else {
  const root = await mkdtemp(join(tmpdir(), "devos-shared-browser-smoke-"));
  const ownedProfile = join(root, "owned");
  const controlProfile = join(root, "control");
  const task = { repo: "host-smoke/shared-browser", issue: process.pid };
  const runtime = browserRuntimePaths(root, task.repo, task.issue);
  const os = process.platform === "darwin"
    ? "macos"
    : process.platform === "win32"
      ? "windows"
      : "linux";
  let control: BrowserContext | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const controlPreset = getRandomPreset(os);
    assert.ok(controlPreset);
    control = await Camoufox({
      user_data_dir: controlProfile,
      persistent_context: true,
      fingerprint_preset: controlPreset,
      headless: true,
      timeout: 15_000,
    });
    const controlPage = control.pages()[0] ?? await control.newPage();
    await controlPage.goto("data:text/html,<title>control</title>");
    assert.equal(await controlPage.evaluate(() => 7 * 6), 42);

    child = spawn(
      process.execPath,
      [...process.execArgv, self, "--runtime-child", root, runtime.socket, runtime.metadata, ownedProfile, task.repo, String(task.issue)],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const ready = await new Promise<{ ready: boolean; js: number; pid: number }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("runtime child readiness timeout")), 20_000);
      child!.once("exit", code => reject(new Error("runtime child exited early: " + code)));
      child!.stdout!.on("data", chunk => {
        buffer += chunk.toString("utf8");
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(buffer.slice(0, end)));
      });
    });
    assert.equal(ready.ready, true);
    assert.equal(ready.js, 42);

    const roots = await profileProcesses(ownedProfile);
    assert.equal(roots.length, 1);
    const ownedPid = roots[0]!.pid;
    const ownerMetadata = JSON.parse(await readFile(runtime.metadata, "utf8"));
    assert.equal(ownerMetadata.browserRoot.pid, ownedPid);
    assert.equal(ownerMetadata.browserRoot.identity, roots[0]!.identity);
    assert.equal(ownerMetadata.profileDir, ownedProfile);

    for (let i = 0; i < 2; i++) {
      const script = [
        "const {createConnection}=require('node:net');",
        "const s=createConnection(process.argv[1]);",
        "s.on('connect',()=>s.end());",
        "s.on('error',e=>{console.error(e);process.exit(1)});",
      ].join("");
      const controller = spawnSync(process.execPath, ["-e", script, runtime.socket], {
        stdio: "inherit",
      });
      assert.equal(controller.status, 0);
      assert.equal((await profileProcesses(ownedProfile))[0]?.pid, ownedPid);
    }

    await closeSharedBrowserRuntime(root, task);

    assert.equal((await profileProcesses(ownedProfile)).length, 0);
    assert.equal((await profileProcesses(controlProfile)).length, 1);
    assert.equal(await controlPage.evaluate(() => 21 * 2), 42);

    await new Promise<void>((resolve, reject) => {
      if (child!.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error("runtime child did not exit")), 8_000);
      child!.once("exit", () => { clearTimeout(timer); resolve(); });
    });

    console.log(JSON.stringify({
      runtimeProcessSurvivedControllerExit: true,
      sameBrowserRootAcrossControllers: true,
      ownedCleanupFallback: true,
      controlSurvived: true,
      browserRootOwnerRecorded: true,
    }));
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await control?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}
