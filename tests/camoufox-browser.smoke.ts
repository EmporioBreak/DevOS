/** Opt-in smoke: npx @camoufox/camoufox fetch && npx tsx tests/camoufox-browser.smoke.ts */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Camoufox } from "@camoufox/camoufox";

const profileDir = await mkdtemp(join(tmpdir(), "devos-camoufox-smoke-"));
let context;
try {
  context = await Camoufox({
    user_data_dir: profileDir,
    persistent_context: true,
    headless: true,
    timeout: 15_000,
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("data:text/html,<title>DevOS Camoufox smoke</title>");
  assert.equal(await page.title(), "DevOS Camoufox smoke");
  assert.equal(await page.evaluate(() => 6 * 7), 42);
  console.log(JSON.stringify({ engine: "camoufox", persistent: true, javascript: 42 }));
} finally {
  await context?.close();
  await rm(profileDir, { recursive: true, force: true });
}
