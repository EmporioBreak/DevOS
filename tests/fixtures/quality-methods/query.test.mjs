import assert from "node:assert/strict";
import test from "node:test";

const source = process.env.DEVOS_QUALITY_TEST_SOURCE;
if (!["buggy.mjs", "fixed.mjs"].includes(source)) throw new Error("Fixture source must be explicit");
const { normalizeQuery } = await import(`./${source}`);

test("does not silently truncate normal input", () => {
  assert.equal(normalizeQuery("hello"), "hello");
});
test("rejects overlong input rather than accepting a shortened value", () => {
  assert.throws(() => normalizeQuery("longer-than-ten"), RangeError);
});
