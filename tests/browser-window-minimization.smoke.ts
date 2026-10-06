/** Opt-in macOS/Linux desktop smoke: npx tsx tests/browser-window-minimization.smoke.ts */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { ChatGptBrowserExecutor } from '../src/chatgpt-browser-executor.js';
import { profileProcesses } from '../src/owned-browser-process.js';

const root = await mkdtemp(join(tmpdir(), 'devos-66-smoke-'));
const ownedProfile = join(root, 'owned');
const controlProfile = join(root, 'control');
const executor = new ChatGptBrowserExecutor({
  projectUrl: 'https://chatgpt.com/g/smoke/project', profileDir: ownedProfile,
  browserChannel: 'chrome', headless: false,
});
let control: BrowserContext | undefined;
async function windowState(context: BrowserContext) {
  const page = context.pages()[0];
  assert.ok(page, 'initial page is reused');
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
    return bounds.windowState;
  } finally { await session.detach(); }
}
try {
  control = await chromium.launchPersistentContext(controlProfile, { channel: 'chrome', headless: false, viewport: null, timeout: 15_000 });
  assert.equal(await windowState(control), 'normal');
  // Exercise the executor's actual launch path, not a duplicate of minimization.
  const owned = await (executor as unknown as { getContext(timeout: number): Promise<BrowserContext> }).getContext(15_000);
  assert.equal(owned.pages().length, 1);
  assert.equal((await profileProcesses(ownedProfile)).length, 1);
  assert.equal((await profileProcesses(controlProfile)).length, 1);
  const ownedState = await windowState(owned);
  const controlState = await windowState(control);
  assert.equal(ownedState, 'minimized');
  assert.equal(controlState, 'normal');
  const javascript = await owned.pages()[0]!.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    return 6 * 7;
  });
  assert.equal(javascript, 42);
  console.log(JSON.stringify({ ownedState, controlState, javascript, initialPages: owned.pages().length }));
} finally {
  const closures = await Promise.allSettled([executor.close(), control?.close()]);
  const ownedRoots = await profileProcesses(ownedProfile);
  const controlRoots = await profileProcesses(controlProfile);
  console.log(JSON.stringify({ cleanup: closures.map(result => result.status), ownedRoots: ownedRoots.length, controlRoots: controlRoots.length }));
  assert.ok(closures.every(result => result.status === 'fulfilled'), 'both contexts close cleanly');
  assert.equal(ownedRoots.length, 0);
  assert.equal(controlRoots.length, 0);
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ profilesRemoved: true }));
}
