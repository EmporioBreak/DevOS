import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { readExactDomFinal } from "../src/chatgpt-dom-recovery.js";

const prompt = "One exact unique DevOS worker prompt";
const final = 'Done.\nDEVOS_RESULT {"status":"done"}';
function turn(role: "user" | "assistant", text: string) {
  return {
    innerText: text, getClientRects: () => [1],
    getAttribute: (field: string) => field === "data-message-author-role" ? role : null,
    querySelector: (query: string) => query === ".markdown" ? { innerText: text } : null,
  };
}
function pageFixture(turns: ReturnType<typeof turn>[], generating = false): Pick<Page, "evaluate"> {
  const document = {
    querySelectorAll(query: string) {
      if (query.startsWith("[data-message-author-role")) return turns;
      return generating ? [{ getClientRects: () => [1] }] : [];
    },
  };
  return {
    async evaluate(fn: Function, input: unknown) {
      return runInNewContext("(" + fn.toString() + ")(input)", { document, input, __name: (value: unknown) => value });
    },
  } as unknown as Pick<Page, "evaluate">;
}
test("read-only DOM fallback confirms stable, exact user ancestor and final machine status", async () => {
  const page = pageFixture([turn("user", prompt), turn("assistant", final)]);
  assert.equal(await readExactDomFinal(page, prompt, 600), final);
});
for (const [name, nodes, generating] of [
  ["wrong prompt", [turn("user", "Other prompt"), turn("assistant", final)], false],
  ["duplicate user message", [turn("user", prompt), turn("assistant", final), turn("user", prompt), turn("assistant", final)], false],
  ["newer unrelated user", [turn("user", prompt), turn("user", "another"), turn("assistant", final)], false],
  ["assistant predates user", [turn("assistant", final), turn("user", prompt)], false],
  ["ambiguous assistant finals", [turn("user", prompt), turn("assistant", final), turn("assistant", final)], false],
  ["status only partial", [turn("user", prompt), turn("assistant", "Still working")], false],
  ["generating spinner", [turn("user", prompt), turn("assistant", final)], true],
] as const) {
  test("read-only DOM refuses " + name, async () => {
    const page = pageFixture([...nodes], generating);
    assert.equal(await readExactDomFinal(page, prompt, 35), null);
  });
}

test("DOM final beats permanently hung SSE waiter without replaying the prompt", { timeout: 5_000 }, async () => {
  const { sendAndRead } = await import("../src/chatgpt-browser-executor.js");
  let sends = 0;
  const page = {
    locator: () => ({ first() { return this; }, async click() { sends++; }, async press() { sends++; } }),
    async waitForFunction() { return await new Promise<never>(() => {}); },
    async evaluate() { return final; },
  } as unknown as Page;
  const text = await Promise.race([
    sendAndRead(page, prompt, 3_000, undefined, { token: 1, useButton: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE incorrectly required")), 1_500)),
  ]);
  assert.equal(text, final);
  assert.equal(sends, 1);
});
