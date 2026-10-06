import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
export async function oauthToken(
  base: string,
  ownerSecret: string,
  resource = "https://connector.example/mcp",
  authMethod: "none" | "client_secret_post" = "none",
) {
  const registration = await fetch(base + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://127.0.0.1:54321/callback"],
      token_endpoint_auth_method: authMethod,
      client_name: "Controlled client",
    }),
  });
  assert.equal(registration.status, 201);
  const client: any = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "test-state",
    scope: "mcp:tools",
    resource,
  });
  const authorize = await fetch(base + "/authorize?" + params, {
    redirect: "manual",
  });
  assert.equal(authorize.status, 200);
  const form = await authorize.text();
  assert.ok(!form.includes(ownerSecret));
  const ticket = /name="ticket" value="([A-Za-z0-9_-]+)"/.exec(form)?.[1];
  assert.ok(ticket);
  const deny = await fetch(base + "/consent", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: new URL(resource).origin,
    },
    body: new URLSearchParams({ ticket, secret: "wrong" }),
    redirect: "manual",
  });
  assert.equal(deny.status, 403);
  const consent = await fetch(base + "/consent", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: new URL(resource).origin,
    },
    body: new URLSearchParams({ ticket, secret: ownerSecret }),
    redirect: "manual",
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "test-state");
  const code = callback.searchParams.get("code")!;
  const tokenParams = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    resource,
    code,
    code_verifier: verifier,
    ...(client.client_secret ? { client_secret: client.client_secret } : {}),
  };
  const exchange = (changes: Record<string, string> = {}) =>
    fetch(base + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...tokenParams, ...changes }),
    });
  if (client.client_secret)
    assert.equal(
      (await exchange({ client_secret: "wrong-client-secret" })).status,
      400,
    );
  assert.equal((await exchange({ code_verifier: "bad-verifier" })).status, 400);
  assert.equal(
    (await exchange({ resource: "https://another.example/mcp" })).status,
    400,
  );
  const response = await exchange();
  assert.equal(response.status, 200);
  const tokens: any = await response.json();
  assert.equal(
    (await exchange()).status,
    400,
    "authorization code is single use",
  );
  return { tokens, client };
}
