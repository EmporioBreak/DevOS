import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveBinding, searchBindingPass, BIND_LIMIT, BIND_PASSES } from '../src/chat-binding.js';
const project = 'https://chatgpt.com/g/demo/project';
const marker = 'DEVOS_BIND_abcdefghijklmnop';
function fixture(count: number, foundAt = -1, text = marker) {
  let current = '';
  const visited: string[] = [];
  const page = {
    async goto(url: string) { current = url; if (url.includes('/c/')) visited.push(url); },
    url() { return current; },
    locator() { return { async all() { return Array.from({length: count}, (_, i) => ({async getAttribute() { return `/g/demo/c/chat-${i}`; }})); } }; },
    getByText(value: string, opts: {exact: boolean}) { return { async count() { return opts.exact && value === text && current.endsWith(`/chat-${foundAt}`) ? 1 : 0; } }; },
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
