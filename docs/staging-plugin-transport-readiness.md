# DevOS 2 — Staging MCP plugin transport preflight (#151)

Date: 2026-10-09. **Real external Cloudflare-to-Staging gateway transport:** PASS. **Actual user Staging plugin in ChatGPT Web/iPhone:** NOT YET VERIFIED. Production migration is forbidden.

## Real read-only network checks

`scripts/staging-public-mcp.smoke.ts` was run from the Mac host against the *current separately running Staging* MCP at `127.0.0.1:8788`. It reads the local OAuth protected resource's origin from the gateway (never hardcodes a rotating Quick Tunnel hostname), and requests the **public Cloudflare HTTPS URL**, without using OAuth client credentials, owner secrets, auth cookies or bearer tokens. Only boolean diagnostic flags are printed, never a public/private hostname, chat ID or token.

All checks were observed PASS:

- Local independent Staging health HTTP 200
- Real external Cloudflare HTTPS `/health` HTTP 200
- Protected-resource metadata HTTP 200 externally and exact `resource` match against local Staging metadata
- OAuth authorization-server discovery HTTP 200 and declared PKCE `S256`
- Unauthenticated POST to remote `/mcp` HTTP **401**
- Separate Production :8787 protected OAuth resource identity compared read-only and **not equal** to Staging
- No Production process restart, config mutation, browser/profile overwrite, secret use or OAuth consent

Earlier #145 SDK regression independently confirmed per-chat **default-deny** with the SAME OAuth client and bearer, protected resources and absence of ordinary tool widget duplication. #150 proved the copied, independent Staging Camoufox profile can open the configured ChatGPT Project without login. Those tests **do not establish actual Staging ChatGPT MCP connection**.

## Actual Web/iPhone plugin acceptance still blocked

- The separate Staging plugin must be connected **from ChatGPT** to this actual Cloudflare OAuth resource. A successful external HTTP discovery probe does not mean ChatGPT granted plugin permissions.
- Verify actual app/tool discovery and Desktop Commander Mac file/shell operation through **that staging ChatGPT connector**, not the independent Production connector.
- Verify the native authorization App approval and Safari fallback on **iPhone** using the Staging connection, no duplicate forms after success, wrong-password retry, and no spillover to unrelated chats sharing the same OAuth client.
- Verify approved worker's actual server-bound session grant only in its exact saved conversation, with no model-role-based bypass.
- Cloudflare Quick Tunnel ephemeral hostname and JSON-only SDK response mode differ from stable named tunnels/SSE. Check browser OAuth resource binding, callback URL, and connection continuity. Preserve copied credentials; re-consent only on a demonstrated issuer/client incompatibility.

## Replay safely

```sh
npx tsx scripts/staging-public-mcp.smoke.ts
```

This command is **read-only network metadata plus unauthorized request**; it never posts a valid access token or modifies either connector. The code never echoes real resource URLs. Tests involving ChatGPT UI require genuine observed results; they cannot be faked by local SDK fixtures.

Keep #151 open and PR draft. E2E #150's first ChatGPT browser turn also remains blocked on unverified terminal response (see #182); do not mistake project navigation for a completed original feature workflow. Release gate is #154.
