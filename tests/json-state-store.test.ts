import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStateStore } from "../src/json-state-store.js";

test("persists orchestration state including worker sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const store = new JsonStateStore(root);
    assert.equal(await store.load(), null);

    await store.save({
      currentWorkerId: "reviewer",
      completedRuns: 3,
      sessions: {
        developer: "codex-session",
        reviewer: "https://chatgpt.com/c/review-session",
      },
    });

    assert.deepEqual(await store.load(), {
      currentWorkerId: "reviewer",
      completedRuns: 3,
      sessions: {
        developer: "codex-session",
        reviewer: "https://chatgpt.com/c/review-session",
      },
    });

    const raw = await readFile(join(root, ".devos", "state.json"), "utf8");
    assert.match(raw, /"sessions"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-state-"));

  try {
    const dir = join(root, ".devos");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "state.json"),
      '{"currentWorkerId":"reviewer","completedRuns":1,"sessions":{"reviewer":""}}\n',
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
