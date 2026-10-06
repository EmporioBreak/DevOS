// Browser consent smoke: system Chrome, fully intercepted HTTPS origin, loopback
// gateway and synthetic credentials only. Never touches saved worker sessions.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { startGateway } from "../src/connector.js";
const secret = randomBytes(32).toString("hex"),
  issuer = "https://browser-smoke.example";
const gateway = await startGateway({
  root: process.cwd(),
  port: 0,
  ownerSecret: secret,
  publicUrl: issuer,
});
const base = `http://127.0.0.1:${gateway.address.port}`;
const callbackServer = createServer((_req, res) =>
  res.end("Controlled callback"),
);
await new Promise<void>((ok) => callbackServer.listen(0, "127.0.0.1", ok));
const callbackUrl = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const registration = await fetch(base + "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Browser smoke",
      redirect_uris: [callbackUrl],
      token_endpoint_auth_method: "none",
    }),
  });
  const client: any = await registration.json();
  assert.equal(registration.status, 201);
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: issuer + "/mcp",
    scope: "mcp:tools",
  });
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== issuer) {
      await route.fulfill({ status: 200, body: "Controlled callback" });
      return;
    }
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "origin"]) {
      const value = request.headers()[key];
      if (value) headers[key] = value;
    }
    const response = await fetch(base + url.pathname + url.search, {
      method: request.method(),
      headers,
      ...(request.postData() ? { body: request.postData()! } : {}),
      redirect: "manual",
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  page.setDefaultTimeout(5000);
  await page.goto(issuer + "/authorize?" + params);
  await page.locator('input[name="secret"]').fill(secret);
  await Promise.all([
    page.waitForURL(callbackUrl + "?*"),
    page.locator('button[type="submit"]').click(),
  ]);
  assert.ok(
    new URL(page.url()).searchParams.get("code"),
    "browser completes the authorized callback",
  );
  console.log(
    "Browser OAuth smoke: owner form submitted successfully with browser-generated Origin; controlled callback only.",
  );
} finally {
  await browser.close();
  await gateway.close();
  await new Promise<void>((ok) => callbackServer.close(() => ok()));
}
