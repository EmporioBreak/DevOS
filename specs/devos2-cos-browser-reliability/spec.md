# Feature: CoS-derived reliable browser command broker for DevOS

**Issue:** [#239](https://github.com/EmporioBreak/DevOS/issues/239) · **Draft PR:** [#240](https://github.com/EmporioBreak/DevOS/pull/240)
**Source benchmark:** https://github.com/totec448-spec/chat-on-steroids
**Pinned upstream:** `9c9ccac195be282011a5e7c8f2ee35e64f8680b7` (MIT)
**Status:** DRAFT — no owner-signed scope/worker graph, no Production rollout authorized.

## Goal

Replace fragmented per-process/browser Send, tab and recovery ownership with **one durable issue-scoped browser command broker**. Adapt CoS's command custody, outbox, provider receipt and bounded DOM observation to the existing DevOS Camoufox/Firefox runtime; do not install CoS/Electron/Chromium MV3 as another automation owner.

## Requirements

**FR-01 — Exact command authority.** One project-local browser command/outbox owner binds approved repo/Issue/worker/turn/graph digest, authenticated MCP grant, process/profile incarnation, task window, tab/document/navigation epoch, saved conversation ID and payload digest. Worker role, browser title, URL or tab position alone cannot grant authority.

**FR-02 — Durable at-most-once Send.** Persist prepared command → exclusive claimed/native side-effect boundary → exact provider-origin user-message receipt → ACK. Composer insertion, click, provider acceptance and model completion are separate evidence. A lost ACK, timeout or ambiguous post-click MUST NOT permit an automatic second Send. Only exact read-only reconciliation may identify the original provider receipt.

**FR-03 — One Camoufox owner per installed project.** Reuse the authorized shared profile/process, one Issue-owned browser window and correctly scoped worker tabs; coordinate with existing [#226](https://github.com/EmporioBreak/DevOS/issues/226) without re-opening or killing its live/ambiguous legacy runtime. Do not duplicate Camoufox, profiles, connectors or authoritative send caches. Tab list failure is unknown, not an empty list. Closing/tearing down a verified approved task's own window must not touch other Issues.

**FR-04 — Active-Issue conversation routing.** Within the SAME unfinished Issue, a predeclared worker resumes its exact existing Project conversation after `changes_requested`/safe recovery. A distinct Issue always gets a new worker conversation and signed MCP grant, even when the worker role matches. Never infer arbitrary user-created private chat IDs from sidebar traversal. Actual post-completion account deletion belongs to [#241](https://github.com/EmporioBreak/DevOS/issues/241), not this PR.

**FR-05 — Bounded DOM and document evidence.** One provider adapter owns selectors and structured observations. Verify authenticated browser/current exact conversation, document ID and monotonic navigation epoch at the mutation boundary. A→B→A with the same URL cannot replay a stale callback. Active drafts, login/verification/protection/consent screens and unknown authorization block automation.

**FR-06 — Signed worker results and isolation.** Browser Send receipt is not a signed MCP worker report and vice versa. Preserve exact Issue/turn/PR/worker/chat identity and `changes_requested` continuity. An active generation can renew only a bounded wait. Main Agent alone accepts final results; Runner's immutable owner-signed graph may not be changed by browser recovery. CoS sleeping-agent reuse and dynamic worker spawning are NOT imported.

**FR-07 — Owner notification transport boundary.** The broker exposes the SAME durable command/receipt transport for the already existing [#224](https://github.com/EmporioBreak/DevOS/issues/224) owner wake-up implementation; #239 must not create a second notification owner, new reminder workflow, or auto-approval. Actual Main Agent notification workflow/E2E remains #224; active-chat switching belongs to [#243](https://github.com/EmporioBreak/DevOS/issues/243).

**FR-08 — Observable fail-closed recovery.** Keep redacted bounded events and persisted leases for preparation/claim/receipt/ACK, process, document and task ownership. Recovery preserves only committed facts, never blindly resends, never restarts a manually closed window, and never treats a PID/page alone as a successful worker result. Unknown old ownership blocks an unsafe browser launch.

**FR-09 — Backward-compatible and opt-in.** No account/session cookie export, hidden account switching, provider restriction bypass, shadow worker/runtime, second profile, or unauthorized cross-Issue side effects. Existing #214/#224/#226, #226 ambiguous turn 6 and explicitly paused #232 MUST remain unchanged. Any actual Production switch requires a separately verified owner-signed scope/graph/skills, real tests and independent review.

## Observable acceptance

A. Two independently authorized Issue windows and same-named worker tabs are isolated in one already approved Camoufox profile/process, without claiming to run a new project-wide task scheduler.

B. Crash injection at prepared/claimed/possibly-clicked/receipt/ACK boundaries shows **at most one native Send attempt** per command ID across restart; receipt must match original provider conversation and user-message ID.

C. A→B→A stale DOM callbacks, altered document epochs, wrong MCP grants, unknown tabs and manual closure fail closed without writing to a foreign chat or silently launching replacements.

D. `changes_requested` in Issue A resumes its saved worker chat; distinct Issue B gets a new chat; the PR, signed report and original graph remain task scoped.

E. Old #226 ambiguous turn 6 remains non-replayed; old trusted runtime may be adopted only with proved safe ownership. No duplicate browser/profile process.

F. Authoritative notification *transport* can serve #224 without duplicate send owner; user busy/idle policy and actual wake-up acceptance are verified under #224, not secretly shipped as #239.

G. TypeScript/build and adversarial process/IPC/DOM tests pass; **genuine headed signed-in ChatGPT browser E2E** and independent security/code review are recorded. Mock/browserless tests alone are not acceptance.

## Intentionally extracted to separate Issues

- [#241](https://github.com/EmporioBreak/DevOS/issues/241): verified deletion of completed Issue worker conversations and task grants (old FR-10..12 / T018..26 beyond active-Issue routing).
- [#242](https://github.com/EmporioBreak/DevOS/issues/242): project-local multi-Issue Runner scheduler, temporary Git worktrees, cleanup and independently installed-client boundaries (old FR-13/14/16..19 / T027..29/31..40).
- [#243](https://github.com/EmporioBreak/DevOS/issues/243): switching authorized Main Agent Chat, project-context recovery from GitHub (old FR-20 / T041/45 handoff).
- [#244](https://github.com/EmporioBreak/DevOS/issues/244): project heartbeat, admission of already approved queued Issues, escalation notices (old FR-21..23 / T042..47).
- [#224](https://github.com/EmporioBreak/DevOS/issues/224): actual Main Agent FINAL_REVIEW_REQUIRED wake-up; [#226](https://github.com/EmporioBreak/DevOS/issues/226): existing shared Camoufox/Issue window groundwork.

These agreed product decisions are **not canceled**; they are out of #239 implementation scope until separately signed, implemented and tested. The parent code/issue does NOT close those tasks automatically.
