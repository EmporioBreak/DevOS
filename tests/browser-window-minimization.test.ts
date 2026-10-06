import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { ChatGptBrowserExecutor, persistentChromeCredentialArgs } from '../src/chatgpt-browser-executor.js';


test('persistent Chrome preserves native macOS credential storage', () => {
  assert.deepEqual(persistentChromeCredentialArgs('darwin'), {
    ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    args: ['--use-real-keychain', '--password-store=keychain'],
  });
  assert.equal(persistentChromeCredentialArgs('linux'), undefined);
});

for (const mode of ['headed', 'headless', 'lookup-failure', 'invalid-id', 'set-failure', 'unconfirmed', 'no-page', 'late-lookup'] as const) {
  test(`owned-window minimization: ${mode}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'devos-window-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const oldDebug = process.env.DEVOS_DEBUG;
    const oldFile = process.env.DEVOS_DEBUG_FILE;
    process.env.DEVOS_DEBUG = '1';
    process.env.DEVOS_DEBUG_FILE = join(dir, 'debug.jsonl');
    t.after(() => {
      if (oldDebug === undefined) delete process.env.DEVOS_DEBUG; else process.env.DEVOS_DEBUG = oldDebug;
      if (oldFile === undefined) delete process.env.DEVOS_DEBUG_FILE; else process.env.DEVOS_DEBUG_FILE = oldFile;
    });
    const commands: Array<{ method: string; params?: unknown }> = [];
    const order: string[] = [];
    let closes = 0;
    let detaches = 0;
    let sessions = 0;
    let resolveLookup: ((value: unknown) => void) | undefined;
    const page = { isClosed: () => false };
    const session = {
      async send(method: string, params?: unknown) {
        commands.push({ method, ...(params === undefined ? {} : { params }) });
        if (method === 'Browser.getWindowForTarget') {
          if (mode === 'lookup-failure') throw Error('account-secret');
          if (mode === 'late-lookup') return new Promise(resolve => { resolveLookup = resolve; });
          return { windowId: mode === 'invalid-id' ? undefined : 42, bounds: { windowState: 'normal' } };
        }
        if (method === 'Browser.setWindowBounds') {
          if (mode === 'set-failure') throw Error('account-secret');
          order.push('minimize');
          return {};
        }
        if (method === 'Browser.getWindowBounds') return { bounds: { windowState: mode === 'unconfirmed' ? 'normal' : 'minimized' } };
        throw Error(`Unexpected CDP command ${method}`);
      },
      async detach() { detaches++; }
    };
    const context = {
      pages: () => mode === 'no-page' ? [] : [page],
      async newCDPSession(target: unknown) { assert.equal(target, page); sessions++; return session; },
      on() {},
      async addInitScript() { order.push('init'); },
      async close() { closes++; }
    };
    t.mock.method(chromium, 'launchPersistentContext', async (_profile: string, options: { headless?: boolean }) => {
      assert.equal(options.headless, mode === 'headless');
      return context;
    });
    const executor = new ChatGptBrowserExecutor({ profileDir: dir, projectUrl: 'https://chatgpt.com/g/one/project', browserChannel: 'chrome', headless: mode === 'headless' });
    const launched = await (executor as unknown as { getContext(timeout: number): Promise<BrowserContext> }).getContext(mode === 'late-lookup' ? 25 : 1000);
    assert.equal(launched, context);
    await executor.close();
    assert.equal(closes, 1);
    if (resolveLookup) {
      resolveLookup({ windowId: 42 });
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (mode === 'headless' || mode === 'no-page') {
      assert.equal(sessions, 0);
      assert.deepEqual(commands, []);
    } else {
      assert.equal(sessions, 1);
      assert.equal(detaches, 1);
      assert.equal(commands[0]?.method, 'Browser.getWindowForTarget');
      const writes = commands.filter(item => item.method === 'Browser.setWindowBounds');
      assert.deepEqual(writes, ['lookup-failure', 'invalid-id', 'late-lookup'].includes(mode) ? [] : [
        { method: 'Browser.setWindowBounds', params: { windowId: 42, bounds: { windowState: 'minimized' } } }
      ]);
    }
    if (mode === 'headed') assert.deepEqual(order, ['minimize', 'init']);
    const log = await readFile(join(dir, 'debug.jsonl'), 'utf8');
    assert.ok(!log.includes('account-secret'));
    const events = log.trim().split('\n').map(line => JSON.parse(line)).filter(item => item.event === 'browser.window.minimize');
    if (mode === 'headless') assert.equal(events.length, 0);
    else {
      assert.equal(events.length, 1);
      assert.equal(events[0].data.decision, mode === 'headed' ? 'minimized' : 'continue-visible');
    }
  });
}
