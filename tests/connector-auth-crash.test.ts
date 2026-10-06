import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorAuth } from "../src/connector-auth.js";

const resource = new URL("https://example.test/mcp");
const secret = "0123456789abcdef0123456789abcdef";

async function seededState(clientsPath: string, path: string) {
  const auth = new ConnectorAuth(resource, secret, clientsPath, path);
  const client = {
    client_id: "client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
  };
  (auth as any).clients.set(client.client_id, client);
  (auth as any).approvedClients.add(client.client_id);
  (auth as any).persistPublicClients();
  const token = {
    clientId: "client",
    scopes: ["mcp:tools"],
    expires: Date.now() + 60_000,
    resource,
    family: "family",
  };
  (auth as any).refresh.set("old-refresh", token);
  (auth as any).persistAuthState();
}

test("refresh crash before durable commit leaves old refresh valid after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devos-oauth-crash-"));
  const path = join(dir, "state.enc");
  const clientsPath = join(dir, "clients.json");
  try {
    await seededState(clientsPath, path);
    const auth = new ConnectorAuth(resource, secret, clientsPath, path, {
      beforeAuthStateCommit: () => { throw new Error("crash-before-commit"); },
    });
    await assert.rejects(
      auth.exchangeRefreshToken({ client_id: "client" } as any, "old-refresh"),
      /crash-before-commit/,
    );
    const restarted = new ConnectorAuth(resource, secret, clientsPath, path);
    const rotated = await restarted.exchangeRefreshToken({ client_id: "client" } as any, "old-refresh");
    assert.ok(rotated.refresh_token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh crash after durable commit never resurrects consumed refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "devos-oauth-crash-"));
  const path = join(dir, "state.enc");
  const clientsPath = join(dir, "clients.json");
  try {
    await seededState(clientsPath, path);
    const auth = new ConnectorAuth(resource, secret, clientsPath, path, {
      afterAuthStateCommit: () => { throw new Error("crash-after-commit"); },
    });
    await assert.rejects(
      auth.exchangeRefreshToken({ client_id: "client" } as any, "old-refresh"),
      /crash-after-commit/,
    );
    const restarted = new ConnectorAuth(resource, secret, clientsPath, path);
    await assert.rejects(
      restarted.exchangeRefreshToken({ client_id: "client" } as any, "old-refresh"),
      /Invalid refresh token|Invalid or expired|invalid_grant/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
