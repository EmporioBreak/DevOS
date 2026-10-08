import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readChatBinding } from "../src/chat-binding.js";
import {
  runDeferredTokenBindingJob,
  scheduleTokenBinding,
  TOKEN_BIND_INITIAL_DELAY_MS,
} from "../src/chat-binding-token.js";

const token = "DEVOS_BIND_abcdefghijklmnop";
const project =
  "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635-denis-devos/";

test("schedules one detached token worker and records pending generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-token-bind-"));
  let unref = false;
  let spawnArgs:
    | { command: string; args: string[]; options: SpawnOptions }
    | undefined;
  try {
    await scheduleTokenBinding(
      token,
      project,
      root,
      "/devos/cli.js",
      ["--import=tsx"],
      (command, args, options) => {
        spawnArgs = { command, args, options };
        return {
          once() { return this; },
          unref() { unref = true; },
        } as never;
      },
    );
    assert.equal(unref, true);
    assert.equal(spawnArgs?.options.detached, true);
    assert.equal(spawnArgs?.options.cwd, root);
    assert.deepEqual(
      spawnArgs?.args.slice(-4, -1),
      ["--devos-bind-token-worker", token, project],
    );
    const requestId = spawnArgs?.args.at(-1);
    assert.match(requestId ?? "", /^[\da-f-]{36}$/);
    const pending = await readChatBinding(root);
    assert.equal(pending?.status, "pending");
    assert.equal(pending?.requestId, requestId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred token worker persists exact canonical URL before resolving", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-token-bind-"));
  let workerArgs: string[] = [];
  try {
    await scheduleTokenBinding(
      token,
      project,
      root,
      "/devos/cli.js",
      [],
      (_command, args) => {
        workerArgs = args;
        return { once() { return this; }, unref() {} } as never;
      },
    );
    const requestId = workerArgs.at(-1)!;
    const url =
      "https://chatgpt.com/g/g-p-6aba984334d881918dea8eb28b1df635/c/current-chat";
    let waited = false;
    const resolved = await runDeferredTokenBindingJob(
      token,
      project,
      root,
      requestId,
      {
        wait: async milliseconds => {
          assert.equal(milliseconds, TOKEN_BIND_INITIAL_DELAY_MS);
          waited = true;
        },
        bind: async (_token, _project, _root, onResolved) => {
          assert.equal(waited, true);
          await onResolved?.(url);
          assert.equal((await readChatBinding(root))?.conversationUrl, url);
          return url;
        },
      },
    );
    assert.equal(resolved, url);
    assert.equal((await readChatBinding(root))?.status, "resolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("token worker records explicit bounded-resolution failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-token-bind-"));
  let workerArgs: string[] = [];
  try {
    await scheduleTokenBinding(
      token,
      project,
      root,
      "/devos/cli.js",
      [],
      (_command, args) => {
        workerArgs = args;
        return { once() { return this; }, unref() {} } as never;
      },
    );
    await assert.rejects(
      runDeferredTokenBindingJob(
        token,
        project,
        root,
        workerArgs.at(-1)!,
        {
          wait: async () => {},
          bind: async () => {
            throw new Error("bind_not_found");
          },
        },
      ),
      /bind_not_found/,
    );
    const failed = await readChatBinding(root);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "bind_not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
