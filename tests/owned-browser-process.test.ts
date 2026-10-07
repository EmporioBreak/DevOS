import assert from "node:assert/strict";
import test from "node:test";
import { parseProfileProcesses } from "../src/owned-browser-process.js";

test("identifies only the Camoufox root with the exact profile", () => {
  const profile = "/tmp/devos-camoufox-profile";
  const processes = parseProfileProcesses(
    [
      `101 /Applications/Camoufox.app/Contents/MacOS/camoufox -profile ${profile}`,
      `102 /Applications/Camoufox.app/Contents/MacOS/camoufox -contentproc -profile ${profile}`,
      "103 /Applications/Camoufox.app/Contents/MacOS/camoufox -profile /tmp/other",
      `104 /usr/local/bin/camoufox-bin --profile ${profile}`,
      `105 /usr/bin/firefox -profile ${profile}`,
      `106 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profile}`,
    ].join("\n"),
    profile,
  );

  assert.deepEqual(processes.map(item => item.pid), [101, 104, 105]);
});

test("refuses ambiguous profile paths containing whitespace", () => {
  assert.deepEqual(
    parseProfileProcesses("101 /usr/bin/camoufox -profile /tmp/profile with space", "/tmp/profile with space"),
    [],
  );
});
