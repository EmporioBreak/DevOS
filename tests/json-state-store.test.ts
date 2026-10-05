import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore } from "../src/json-state-store.js";

test("returns null before state exists and persists state atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const store = new JsonStateStore(root);
    assert.equal(await store.load(), null);

    await store.save({ currentWorkerId: "reviewer", completedRuns: 3 });

    assert.deepEqual(await store.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 3,
    });

    const raw = await readFile(join(root, ".devos", "state.json"), "utf8");
    assert.match(raw, /"currentWorkerId": "reviewer"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed persisted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const dir = join(root, ".devos");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "state.json"),
      '{"currentWorkerId":"","completedRuns":-1}\n',
      "utf8",
    );

    await assert.rejects(
      () => new JsonStateStore(root).load(),
      /Invalid DevOS state/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
