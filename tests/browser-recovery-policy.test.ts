import assert from "node:assert/strict";
import test from "node:test";
import { classifyBrowserFailure, browserRecoveryDelayMs } from "../src/browser-recovery-policy.js";

test("recoverable pre-send navigation and connectivity errors share one recovery policy", () => {
  for (const reason of ["Timeout waiting for composer", "net::ERR_CONNECTION_RESET",
    "NS_ERROR_NET_TIMEOUT", "NS_ERROR_OFFLINE", "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_NAME_NOT_RESOLVED", "Transient navigation HTTP 503", "Transient backend HTTP 502",
    "ChatGPT authentication/challenge blocked backend (HTTP 403)",
    "ChatGPT passive challenge page", "Temporary ChatGPT interstitial HTTP 403"]) {
    assert.equal(classifyBrowserFailure(new Error(reason)).action, "retry", reason);
  }
});
test("interactive human checks wait without automation", () => {
  for (const reason of ["ChatGPT interactive challenge: Verify you are human", "CAPTCHA required"]) {
    assert.equal(classifyBrowserFailure(new Error(reason)).action, "human", reason);
  }
});
test("provider refusals, identity drift, and unknown errors cannot silently retry", () => {
  for (const reason of ["ChatGPT authentication required", "ChatGPT authentication/access blocked backend (HTTP 403)",
    "ChatGPT navigation rejected (HTTP 429)", "ChatGPT challenge blocked due to explicit provider policy",
    "ChatGPT conversation unavailable (HTTP 404)", "ChatGPT browser escaped the configured Project",
    "ChatGPT redirected to a different conversation", "net::ERR_CERT_AUTHORITY_INVALID",
    "unknown failure"]) {
    assert.equal(classifyBrowserFailure(new Error(reason)).action, "stop", reason);
  }
});
test("reload delays stay inside the same bounded deadline", () => {
  assert.ok(browserRecoveryDelayMs(1, 20000) > 0);
  assert.ok(browserRecoveryDelayMs(2, 20000) > browserRecoveryDelayMs(1, 20000));
  assert.equal(browserRecoveryDelayMs(2, 1), 0);
  assert.ok(browserRecoveryDelayMs(3, 20000) <= 2500);
});
