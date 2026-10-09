# DevOS 2 Staging/Production MCP security boundary — Issue #145

The working ngrok Production connector and Cloudflare Staging connector remain independent services with distinct loopback ports, public OAuth resource identities, local state and browser profiles. **No production process, authorization record, OAuth secret or profile is edited by this PR.**

## Default-deny / lazy authorization

A ChatGPT OAuth bearer token is **not** permission for a particular chat. Each user-created conversation must already be individually approved before Desktop Commander or owner-only Skills Library tools are available. `devos_noop` is side-effect-free; the authorization form is requested **only** when a user actually attempts a DevOS/MCP operation. Ordinary tools do not carry a new approval App template and do not duplicate prior password forms.

`devos_skill_policy_get/set`, `devos_skill_diagnostics`, `devos_skill_update_preview` and the settings UI resource require an approved owner-chat fingerprint. The new browser worker tools `devos_skill_manifest/search/read` require a **different authority**: the live signed worker grant for the exact chat/Issue/worker/turn **and** the owner's HMAC-signed skill assignment. Merely copying the OAuth client, schema, role, URL or task number gives no access.

## Regression evidence

The real MCP SDK integration test in `tests/connector.test.ts` now exercises one approved chat and another unauthorized chat sharing **the same OAuth client and token**. The unapproved chat cannot read Mac files, write files, update owner skill preferences, obtain a skill list, search/read a task skill, enumerate the owner diagnostic inventory or view the protected settings UI. The denied side-effect file never appears and the Git-backed policy is unchanged. No default App output template is attached to ordinary denied tool results. The owner-approved regular chat also cannot impersonate a browser worker's server-signed grant.

```sh
npm run build
npx tsx --test --test-name-pattern='loopback HTTP refuses anonymous' tests/connector.test.ts
node scripts/staging-isolation-smoke.mjs
```

The read-only script queries **only local** production 8787 and staging 8788: health, OAuth protected resource metadata, unauthorized /mcp response and different resource identities. It never prints or sends OAuth secrets, never authenticates as a user and never restarts services. This is host separation evidence, **not** proof that the remote Cloudflare hostname is stable or the app is usable in ChatGPT Web/iPhone.

## Outstanding live work

Real Web/iOS MCP App rendering, Safari fallback/continuation and confirmed absence of duplicate auth popups require **actual owner interaction** through the separate Staging plugin (#151). A Cloudflare Quick Tunnel's public hostname can change, and OAuth consent may be issuer-bound; preserving copied local credentials doesn't guarantee ChatGPT will accept them without a fresh consent. Do not reset production state or pretend the live iPhone UI was tested by the MCP SDK alone.

Final release security and stress testing remain #149/#152. Keep the PR draft and do not merge before independent review.
