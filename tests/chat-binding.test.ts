import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindChat, readChatBinding, resolveBinding, runDeferredBindingJob, scheduleChatBinding, searchBindingPass, BIND_LIMIT, BIND_PASSES, BIND_PUBLICATION_DELAY_MS } from '../src/chat-binding.js';
const project = 'https://chatgpt.com/g/demo/project';
const marker = 'DEVOS_BIND_abcdefghijklmnop';
function fixture(count: number, foundAt = -1, text = marker, options: { order?: number[]; timestamps?: string[]; delayed?: boolean } = {}) {
  let current = '';
  const visited: string[] = [];
  const order = options.order ?? Array.from({ length: count }, (_, i) => i);
  const rendered = new Set<string>();
  const page = {
    async goto(url: string) { current = url; if (url.includes('/c/')) { visited.push(url); if (!options.delayed) rendered.add(url); } },
    url() { return current; },
    locator() { return { async all() { return order.map(i => ({
      async getAttribute(name: string) {
        if (name === 'href') return `/g/demo/c/chat-${i}`;
        if (name === 'data-updated-at') return options.timestamps?.[i] ?? null;
        return null;
      },
    })); } }; },
    getByText(value: string, opts: {exact: boolean}) { return {
      async count() { return opts.exact && value === text && rendered.has(current) && current.endsWith(`/chat-${foundAt}`) ? 1 : 0; },
      async waitFor() { rendered.add(current); },
    }; },
  };
  return { page, visited };
}
test('stops on exact matching chat and returns exact URL', async () => {
  const f = fixture(20, 3);
  assert.equal(await resolveBinding(f.page, project, marker), 'https://chatgpt.com/g/demo/c/chat-3');
  assert.equal(f.visited.length, 4);
});
test('does not accept substring or wrong marker', async () => {
  const f = fixture(2, 0, marker + '-suffix');
  await assert.rejects(resolveBinding(f.page, project, marker, async () => {}), /bind_not_found/);
});
test('caps one pass at thirty conversations', async () => {
  const f = fixture(55, 40);
  assert.equal(await searchBindingPass(f.page, project, marker), null);
  assert.equal(f.visited.length, BIND_LIMIT);
});
test('orders timestamped links newest-first before applying the cap', async () => {
  const order = Array.from({ length: 35 }, (_, i) => i);
  const timestamps = order.map(i => new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString());
  const f = fixture(35, 30, marker, { order: [...order].reverse(), timestamps });
  assert.equal(await searchBindingPass(f.page, project, marker), 'https://chatgpt.com/g/demo/c/chat-30');
  assert.deepEqual(f.visited.slice(0, 5).map(url => Number(url.split('chat-')[1])), [34, 33, 32, 31, 30]);
});
test('waits for asynchronously rendered exact marker text', async () => {
  const f = fixture(1, 0, marker, { delayed: true });
  assert.equal(await resolveBinding(f.page, project, marker), 'https://chatgpt.com/g/demo/c/chat-0');
});
test('bounded retries and explicit failure', async () => {
  const f = fixture(1);
  let waits = 0;
  await assert.rejects(resolveBinding(f.page, project, marker, async () => { waits++; }), /bind_not_found/);
  assert.equal(waits, BIND_PASSES - 1);
  assert.equal(f.visited.length, BIND_PASSES);
});
test('rejects invalid marker before navigation', async () => {
  const f = fixture(1);
  await assert.rejects(resolveBinding(f.page, project, 'invalid'), /bind_invalid_marker/);
  assert.equal(f.visited.length, 0);
});
test('removes marker file when validation fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devos-bind-test-'));
  const markerFile = join(dir, 'marker');
  await writeFile(markerFile, 'invalid');
  try {
    await assert.rejects(bindChat(markerFile), /bind_invalid_marker/);
    await assert.rejects(readFile(markerFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('removes marker file when browser configuration fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devos-bind-test-'));
  const markerFile = join(dir, 'marker');
  const previous = process.env.DEVOS_BROWSER_HEADLESS;
  await writeFile(markerFile, marker);
  process.env.DEVOS_BROWSER_HEADLESS = 'invalid';
  try {
    await assert.rejects(bindChat(markerFile), /DEVOS_BROWSER_HEADLESS/);
    await assert.rejects(readFile(markerFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.DEVOS_BROWSER_HEADLESS;
    else process.env.DEVOS_BROWSER_HEADLESS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test('schedules a one-shot binding worker and returns before lookup starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devos-bind-test-'));
  const markerFile = join(dir, 'marker');
  let unrefCalled = false;
  let spawnArgs: { command: string; args: string[]; options: SpawnOptions } | undefined;
  await writeFile(markerFile, marker);
  try {
    await scheduleChatBinding(markerFile, project, dir, '/devos/cli.js', ['--import=tsx'], (command, args, options) => {
      spawnArgs = { command, args, options };
      return { once() { return this; }, unref() { unrefCalled = true; } } as never;
    });
    assert.equal(unrefCalled, true);
    assert.equal(spawnArgs?.options.cwd, dir);
    assert.equal(spawnArgs?.options.detached, true);
    assert.deepEqual(spawnArgs?.args.slice(-4), ['/devos/cli.js', '--devos-bind-chat-worker', markerFile, project]);
    assert.deepEqual(await readChatBinding(dir), { version: 1, status: 'pending', projectUrl: project, requestedAt: (await readChatBinding(dir))?.requestedAt });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('defers lookup until marker publication and persists exact URL before cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devos-bind-test-'));
  const markerFile = join(dir, 'marker');
  const url = 'https://chatgpt.com/g/demo/c/current-chat';
  let markerPublished = false;
  await writeFile(markerFile, marker);
  try {
    assert.equal(await runDeferredBindingJob(markerFile, project, dir, {
      wait: async milliseconds => {
        assert.equal(milliseconds, BIND_PUBLICATION_DELAY_MS);
        markerPublished = true;
      },
      bind: async (_file, _project, onResolved) => {
        assert.equal(markerPublished, true);
        assert.ok(onResolved);
        await onResolved!(url);
        assert.equal((await readChatBinding(dir))?.conversationUrl, url);
        return url;
      },
    }), url);
    assert.equal((await readChatBinding(dir))?.conversationUrl, url);
    await assert.rejects(readFile(markerFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('persists explicit failure and removes marker after exhausted lookup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devos-bind-test-'));
  const markerFile = join(dir, 'marker');
  await writeFile(markerFile, marker);
  try {
    await assert.rejects(runDeferredBindingJob(markerFile, project, dir, {
      wait: async () => {},
      bind: async () => { throw new Error('bind_not_found'); },
    }), /bind_not_found/);
    assert.equal((await readChatBinding(dir))?.status, 'failed');
    assert.equal((await readChatBinding(dir))?.error, 'bind_not_found');
    await assert.rejects(readFile(markerFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
