import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import {
  ChatGptBrowserExecutor,
  chatGptBrowserDeps,
} from "../src/chatgpt-browser-executor.js";

for (const headless of [false, true]) {
  test(`Camoufox persistent launch preserves profile and headless=${headless}`, async t => {
    const profileDir = await mkdtemp(join(tmpdir(), "devos-camoufox-test-"));
    t.after(() => rm(profileDir, { recursive: true, force: true }));

    let initScripts = 0;
    let closes = 0;
    const context = {
      pages: () => [],
      on() {},
      async addInitScript() { initScripts++; },
      async close() { closes++; },
    } as unknown as BrowserContext;

    const identity = {
      schema: 1 as const,
      os: "macos" as const,
      preset: { userAgent: "stable-preset" },
    };
    t.mock.method(chatGptBrowserDeps, "loadIdentity", async profile => {
      assert.equal(profile, profileDir);
      return identity;
    });

    let launches = 0;
    t.mock.method(
      chatGptBrowserDeps,
      "launchPersistentContext",
      async (profile: string, options) => {
        launches++;
        assert.equal(profile, profileDir);
        assert.equal(options.headless, headless);
        assert.equal(options.timeout, 1_000);
        assert.equal(options.identity, identity);
        return context;
      },
    );

    const executor = new ChatGptBrowserExecutor({
      projectUrl: "https://chatgpt.com/g/one/project",
      profileDir,
      headless,
    });

    const launched = await (
      executor as unknown as { getContext(timeout: number): Promise<BrowserContext> }
    ).getContext(1_000);

    assert.equal(launched, context);
    assert.equal(launches, 1);
    assert.equal(initScripts, 1);
    await executor.close();
    assert.equal(closes, 1);
  });
}
