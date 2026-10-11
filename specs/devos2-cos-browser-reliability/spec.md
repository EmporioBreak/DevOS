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

**FR-07 — End-to-end owner notification integration.** The broker provides the ONLY durable Send claim/receipt transport used by the existing [#224](https://github.com/EmporioBreak/DevOS/issues/224) signed Main Agent wake-up feature. Its existing owner identity, private editable \`/c/\` destination (including verified \`/share/\` redirect), `final_review_required` round, busy/idle checks, timeout reconciliation and user-role message must produce a REAL provider-confirmed owner-chat turn. No second sender/ledger and no automatic owner approval. Cross-chat handoff beyond this existing saved owner binding belongs to [#243](https://github.com/EmporioBreak/DevOS/issues/243).

**FR-08 — Observable fail-closed recovery.** Keep redacted bounded events and persisted leases for preparation/claim/receipt/ACK, process, document and task ownership. Recovery preserves only committed facts, never blindly resends, never restarts a manually closed window, and never treats a PID/page alone as a successful worker result. Unknown old ownership blocks an unsafe browser launch.

**FR-09 — Backward-compatible and opt-in.** No account/session cookie export, hidden account switching, provider restriction bypass, shadow worker/runtime, second profile, or unauthorized cross-Issue side effects. Existing #214/#224/#226, #226 ambiguous turn 6 and explicitly paused #232 MUST remain unchanged. Any actual Production switch requires a separately verified owner-signed scope/graph/skills, real tests and independent review.

## Unified product delivery gate — #224 + #226 + #239 (owner clarification)

**The feature to ship is a WORKING BROWSER-WORKER LOOP, not a broker-only API.** #239 is the parent integration/acceptance gate for the existing [#226 / PR #227](https://github.com/EmporioBreak/DevOS/pull/227) shared Camoufox Issue-window implementation, the existing [#224 / PR #225](https://github.com/EmporioBreak/DevOS/pull/225) exact signed Main Agent final-review wake-up, AND the new durable CoS-inspired browser command broker in [#239 / PR #240](https://github.com/EmporioBreak/DevOS/pull/240). **Do not declare #239 complete, merge its release integration, or report the browser-worker product delivered until all three work together on the actual authorized provider session and pass the shared real E2E.** Unit-only, empty-profile Camoufox smoke, pending notification intent and synthetic report are not sufficient.

**Reuse, don't rewrite:** PR #227 already changes `src/shared-browser-runtime.ts`, `src/chatgpt-browser-executor.ts` and task/window tests. PR #225 already changes `src/owner-wakeup-{handoff,ledger}.ts`, `src/owner-task-approval.ts`, `src/cli.ts` and owner tests. PR #240 currently has ONLY the isolated browser command matcher/proposed spec. The developer must study **both exact existing source diffs and owner/reviewer reports**, verify compatibility, and integrate their verified work into the canonical single command/outbox and existing process ownership; **do not implement a parallel window manager, sender or notification ledger**. Shared code may require a reviewed consolidated change rather than blindly cherry-picking divergent branch snapshots. Preserve original #224/#226 PRs and signed worker graph/turn lifecycle; do not abandon, prematurely close, misrepresent their completion or overwrite their branch. Integration sequencing/merge decisions belong to Main Agent after independent evidence, never to an unsupervised browser worker.

**Dependencies are not mere links:** #227's legacy-to-shared Production-profile adoption and safe two-window operation must be actually reconciled (known original #214/#226 live owners; #226 turn 6 potentially submitted). #225's authorized `/share/`→original editable `/c/` owner binding and real safe busy/idle notification delivery must be completed. #240's outbox must be the **single durable side-effect authority** for worker and owner-notification Sends, not a third queue and not a competing sender. If any original prerequisite remains blocked, #239's integrated release remains BLOCKED, not partially approved.

**Release is atomic at the product level, not necessarily one GitHub PR:** retain the original Issue/PR ownership for #224/#226/#239; verify exact dependency SHAs, merge compatible reviewed source changes under Main Agent-controlled git sequencing, run full integration tests against their combined effective codebase, and gate final browser-workflow acceptance on all required GitHub PR/merge and signed report evidence. Neither standalone PR's unit suite nor #239 matcher makes the whole feature ready.

## Observable acceptance

A. Two independently authorized Issue windows and same-named worker tabs are isolated in one already approved Camoufox profile/process, without claiming to run a new project-wide task scheduler.

B. Crash injection at prepared/claimed/possibly-clicked/receipt/ACK boundaries shows **at most one native Send attempt** per command ID across restart; receipt must match original provider conversation and user-message ID.

C. A→B→A stale DOM callbacks, altered document epochs, wrong MCP grants, unknown tabs and manual closure fail closed without writing to a foreign chat or silently launching replacements.

D. `changes_requested` in Issue A resumes its saved worker chat; distinct Issue B gets a new chat; the PR, signed report and original graph remain task scoped.

E. Old #226 ambiguous turn 6 remains non-replayed; old trusted runtime may be adopted only with proved safe ownership. No duplicate browser/profile process.

F. The integrated authorized #224 sender actually delivers exactly one provider-confirmed visible user-role notification into the exact previously approved Main Agent conversation for each new final-review round; busy/idle defers safely, \`/share/\` resolves only to verified original writable \`/c/\`, and reply enters the same GitHub Issue's Main Agent review. This must work with #239's ONE durable outbox, not a second sender.

G. Combined effective #224+#226+#239 code builds and passes affected full regression, adversarial process/IPC/DOM/owner-notification tests and genuine headed signed-in ChatGPT browser E2E; original signed reviews, security check and Main Agent acceptance are recorded. No three independent mock PASS flags can replace the one integrated E2E.

## Execution capability and proof — dedicated local Codex visual QA (owner correction)

The owner has explicitly confirmed that DevOS's `chatgpt_browser` worker **cannot perform the required genuine real-user visual browser E2E**. Do not dispatch it as visual QA merely to generate `needs_local_worker` or claim an E2E pass from DOM/headless tests. The predeclared main developer, security auditor, host-process QA, **independent real visual GUI E2E QA**, and **independent final reviewer** for #239 use five separate `codex` executions in the ONE original Runner graph. The QA Codex worker is assigned directly, not activated as a fallback after an intentionally incapable worker. Visual QA and final reviewer may not self-approve the original implementation.

Prior to native GUI actions, QA must **prove actual permission** to control/observe the logged-in macOS desktop and authenticated, safely owned original Camoufox session. Presence of `codex`, `osascript`, `screencapture`, Playwright or a console session alone is NOT proof of accessibility/screen-recording rights or provider automation compliance. Perform real visible headed interaction (pointer/keyboard/Computer Use) and inspect actual screenshots or video of observed window/tab/navigation/notification states, alongside exact original provider message IDs and authenticated signed worker reports. A scripted headless test, Playwright-only run or fabricated screenshot is not a human-equivalent visual E2E. If host GUI, provider authorization, approved disposable tasks or safe legacy ownership are missing, report a concrete blocker; never substitute an unverifiable PASS, start a second Camoufox/profile or send the ambiguous #226 turn 6.

The prior owner-approval preview was bound to the **old six-worker graph and commit SHA** and cannot authorize this changed five-worker graph. Full verified exact Spec Kit SHA, five-worker graph and skills roster require fresh owner-password-backed approval before DevOS Runner or any production-affecting test.

## Required single headed user-journey acceptance

1. In the already-authorized single project Camoufox/profile, launch two approved disposable Issues A and B (one top-level window each, task-specific worker tabs). No duplicate Camoufox process, connector or profile; no cross-Issue tabs/grants.
2. Worker A submits one prompt via the unique claimed command; observe exact provider accepted outgoing user-message ID and independently signed terminal MCP report. A timeout after attempted Send cannot cause a second prompt, including after restart.
3. Original independent reviewer of A reports and reaches real `FINAL_REVIEW_REQUIRED`; old A worker chats/PR stay alive. The existing #224 authorized owner handoff opens **the original verified Main Agent chat**, waits for it to be idle, sends exactly one ordinary user-role notice and obtains the provider receipt. Never use a fake system message, static stdout or another owner chat.
4. Main Agent sees original Issue/spec/PR/QA report and chooses `changes_requested`; A's SAME worker conversation resumes in A's own window and same PR while Issue B remains usable. A's next signed review round produces exactly one new owner notice, not a duplicate prior one.
5. Main Agent approves A with actual evidence; #226 task-scoped browser window teardown closes ONLY A's eligible window/tabs after the required completed gate, not B or shared profile. Cross-Issue owner/browser/session isolation survives process recovery.
6. Independently test the retained legacy Production profile/task owner bridge rather than merely launching a clean test profile. If safe migration/receipt cannot be verified, stop with a truthful blocked status; do NOT replay #226 turn 6, kill or close #214, copy cookies or manufacture signed reports.
7. Review and integrate actual PR #225 and PR #227 code plus #240 broker. The combined merged/release candidate must pass the whole scenario, independent review and genuine provider receipts before #239 and the overall browser capability may be called **done**.

## Intentionally extracted to separate Issues

- [#241](https://github.com/EmporioBreak/DevOS/issues/241): verified deletion of completed Issue worker conversations and task grants (old FR-10..12 / T018..26 beyond active-Issue routing).
- [#242](https://github.com/EmporioBreak/DevOS/issues/242): project-local multi-Issue Runner scheduler, temporary Git worktrees, cleanup and independently installed-client boundaries (old FR-13/14/16..19 / T027..29/31..40).
- [#243](https://github.com/EmporioBreak/DevOS/issues/243): switching authorized Main Agent Chat, project-context recovery from GitHub (old FR-20 / T041/45 handoff).
- [#244](https://github.com/EmporioBreak/DevOS/issues/244): project heartbeat, admission of already approved queued Issues, escalation notices (old FR-21..23 / T042..47).
- [#224](https://github.com/EmporioBreak/DevOS/issues/224): actual Main Agent FINAL_REVIEW_REQUIRED wake-up; [#226](https://github.com/EmporioBreak/DevOS/issues/226): existing shared Camoufox/Issue window groundwork.

These agreed product decisions are **not canceled**; they are out of #239 implementation scope until separately signed, implemented and tested. The parent code/issue does NOT close those tasks automatically.
