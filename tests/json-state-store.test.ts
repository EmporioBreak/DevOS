import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore } from "../src/json-state-store.js";

test("isolates state by GitHub task", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const first = new JsonStateStore(root, { repo: "owner/product", issue: 41 });
    const second = new JsonStateStore(root, { repo: "owner/product", issue: 42 });

    assert.notEqual(first.path, second.path);
    assert.equal(await first.load(), null);
    assert.equal(await second.load(), null);

    await first.save({
      currentWorkerId: "reviewer",
      completedRuns: 3,
      sessions: { reviewer: "session-one" },
    });

    assert.deepEqual(await first.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 3,
      sessions: { reviewer: "session-one" },
    });
    assert.equal(await second.load(), null);

    const raw = await readFile(first.path, "utf8");
    assert.match(raw, /"session-one"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clear removes only the active task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const first = new JsonStateStore(root, { repo: "owner/product", issue: 41 });
    const second = new JsonStateStore(root, { repo: "owner/product", issue: 42 });

    await first.save({
      currentWorkerId: "worker",
      completedRuns: 1,
      sessions: {},
    });
    await second.save({
      currentWorkerId: "worker",
      completedRuns: 2,
      sessions: {},
    });

    await first.clear();

    assert.equal(await first.load(), null);
    assert.deepEqual(await second.load(), {
      currentWorkerId: "worker",
      completedRuns: 2,
      sessions: {},
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
