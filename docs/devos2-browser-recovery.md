# DevOS 2 browser recovery — migration fix #222

## Provenance and scope

Inspired by Chat On Steroids (MIT): [browser repair owner checks](https://github.com/totec448-spec/chat-on-steroids/blob/main/extension/background.js) and [turn-signal inventory](https://github.com/totec448-spec/chat-on-steroids/blob/main/docs/chatgpt-turn-signals.md). DevOS adapts the *design*, not its extension, cookie-transfer system or browser manager.

The DevOS Runner already has durable worker/chat URLs, saved one-shot turn identity, and read-only post-submission reconciliation. This change adds shared error classification and same-tab pre-submit repair without changing those invariants.

## Recovery ownership

- **Before Send is proven**: classify errors as retry, human-check, or stop. Retry temporary network/navigation failures, passive interstitials, page readiness failures and HTTP 408/425/5xx within **three navigations / 45 seconds**. Use the same browser profile and the same saved Project/conversation route, with bounded delay.
- **After Send may have happened**: never replay the prompt. Accept only an exact server-side MCP report or a verified matching user-turn read-only recovery. If the identity is missing, ambiguous, or changed, halt for inspection.
- **Human verification**: CAPTCHA/Turnstile and interactive security screens do not receive scripted clicks or solved challenges. Keep the tab visible for the owner; stop the task.
- **Hard refusals**: authentication/login, plain JSON 401/403, HTTP 404/410/429, policy/quota blocks, changed Project/chat identity, and TLS certificate errors cannot be retried automatically.
- **Timeout and cleanup**: if the preparation wall-clock timeout won while navigation was still pending, close that page before retry. Never run two simultaneous navigations on one tab; if the browser crashes, only its proven task-owned context/process may be recovered.

## Regression checks

Use `npm run build`, `npm test`, and the focused `tsx --test tests/browser-recovery-policy.test.ts tests/browser-recovery.test.ts tests/browser-lifecycle-recovery.test.ts tests/chatgpt-browser-executor.test.ts`.

A successful local test is **not** real ChatGPT E2E. Real #214 stays blocked until its original signed-worker browser turn, independent reviewer and Main Agent handoff actually succeed. No changes to Production MCP, passwords, persistent Camoufox profile or worker task state are part of this patch.
