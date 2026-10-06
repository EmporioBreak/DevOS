import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConnectorSecrets, parseEnvFile } from "../src/connector-env.js";

test("parses connector dotenv without evaluating shell syntax", () => {
  assert.deepEqual(parseEnvFile([
    "# comment",
    "NGROK_AUTHTOKEN=from-file",
    "DEVOS_CONNECTOR_OWNER_SECRET=\"owner value\"",
    "IGNORED='literal $HOME'",
    "",
  ].join("\n")), {
    NGROK_AUTHTOKEN: "from-file",
    DEVOS_CONNECTOR_OWNER_SECRET: "owner value",
    IGNORED: "literal $HOME",
  });
});

test("process environment overrides project dotenv", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-env-"));
  try {
    await writeFile(join(root, ".env"), "NGROK_AUTHTOKEN=file-token\nDEVOS_CONNECTOR_OWNER_SECRET=file-owner\n");
    assert.deepEqual(await loadConnectorSecrets(root, {
      NGROK_AUTHTOKEN: "env-token",
      DEVOS_CONNECTOR_OWNER_SECRET: "env-owner",
    }), { ngrokAuthtoken: "env-token", ownerSecret: "env-owner" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing connector secrets name variables without leaking values", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-env-"));
  try {
    await assert.rejects(loadConnectorSecrets(root, {}), /DEVOS_CONNECTOR_OWNER_SECRET.*NGROK_AUTHTOKEN|NGROK_AUTHTOKEN.*DEVOS_CONNECTOR_OWNER_SECRET/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
