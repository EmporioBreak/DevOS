import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindChat, resolveBinding, searchBindingPass, BIND_LIMIT, BIND_PASSES } from '../src/chat-binding.js';
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
