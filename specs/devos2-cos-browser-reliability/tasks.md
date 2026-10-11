# Browser broker implementation tasks — Issue #239

**Status:** Draft only. **Do not start Runner, browser sends or Production migration before signed approval of the exact original Spec Kit, worker graph and skills.**

## Research and prior verified preparation

- [x] T001 Read pinned upstream CoS sources, license and original DevOS AGENTS; pin `9c9ccac195be282011a5e7c8f2ee35e64f8680b7`.
- [x] T002 Source gap map and original Spec Kit drafts, no upstream code copied.
- [x] T015 Isolated pure identity matcher `src/browser-command-identity.ts`; TDD RED/GREEN across exact command/worker/browser document/epoch/receipt.
- [x] T016 Prior scoped test run 122/122 PASS and build PASS (historical evidence, **not** current full verification or headed E2E).
- [x] T017 Candidate 6-role graph + skills roster drafted; **not signed or dispatched**.

## Exact next browser work (after project approval gate)

- [ ] T003 Main Agent secures verified owner password-backed agreement to the **unified #224+#226+#239 browser capability release gate** and this exact #239 integration scope, source SHA, original Spec Kit and immutable complete graph/skills. Do not modify existing #224/#226 signed worker graphs; align cross-Issue dependencies with their original authorizations. This does not authorize #241–#244 or the previous 47-task draft.
- [ ] T004 RED tests for wrong Issue/worker/turn/graph/payload/document/profile and A→B→A navigation; unit identity check is not authorization.
- [ ] T005 Transactional **single** durable browser command/outbox with claim-before-native-effect; retire existing competing volatile send caches when it becomes authoritative.
- [ ] T006 RED/GREEN failure injection at prepare, claim, Send/click ambiguity, exact provider receipt and ACK; reconcile read-only and never auto-replay.
- [ ] T007 AUDIT AND REUSE current #226/PR #227 project Camoufox browser/process ownership, Issue windows and worker tabs. Resolve actual live #214/#226 legacy runtime/profile handoff safely within original approved task boundaries; empty-profile tests alone are not Production E2E. No duplicate profile or global kill.
- [ ] T008 AUDIT AND REUSE #224/PR #225 signed ChatAccess owner binding, per-review-round OwnerWakeupLedger, CLI enqueue and safe /share/→private /c/ navigation. Integrate saved worker grant/IPC with ONE command transport for worker Send and ORIGINAL #224 owner wake-up, not a second sender. Prove actual provider message receipts.
- [ ] T009 Bounded liveness/busy/manual-close/unknown-tab diagnostics, structured redacted events and fail-closed restart.
- [ ] T010 Read-only legacy ownership inventory and safe migration/adoption gate. Preserve #226 turn 6's ambiguity and do not modify #232/legacy trusted sessions.
- [ ] T011 Full COMBINED effective code baseline from PR #225 + PR #227 + PR #240: affected owner-auth/wakeup, IPC/process/recovery/DOM, signed worker/owner reports, adversarial two-Issue isolation and no-duplicate-Send tests all green. Detect branch/API drift before controlled integration; separate suite green stamps alone are NOT enough.
- [ ] T012 **ONE complete real signed-in headed browser E2E** with authorized disposable A/B: single profile + two Issue windows/worker tabs → worker message and provider receipt → signed worker + independent reviewer → #224 real owner-chat user-role notification and receipt while idle, including verified share redirect when applicable → Main Agent changes_requested → SAME A worker chat/PR/window → new owner-round notice exactly once → genuine approval → close ONLY A window while B continues. No shell/headless stand-in.
- [ ] T013 Independent security/code/provider-terms review, changes_requested to the SAME developer/Issue/PR and actual re-tests; Main Agent alone makes final acceptance.
- [ ] T014 Document safe rollout/rollback and MIT attribution if substantial upstream source is imported.
- [ ] T018 Within unfinished Issue, same signed worker resumes original chat on `changes_requested`; a new Issue uses a fresh worker conversation/grant. Post-completion deletion is **#241**, not #239.

## Mandatory integration proof: #224 + #226 + #239

- [ ] T019 Inspect latest PR #225/#227 diffs and signed reports, source API/state authority/merge dependencies, actual missing native owner Send/provider receipts and live legacy blockers. No treating unmerged Draft PR source as deployed.
- [ ] T020 RED/GREEN: #226 shared process and task windows feed #239 exclusive claim; worker tabs, corrections and task-local close cannot cross Issue isolation. Reconcile #214/#226 live owners and turn 6 safely or block release.
- [ ] T021 RED/GREEN: reuse #225 exact HMAC-signed owner target, enqueue/round ledger and busy-idle policy; connect existing notification intent to #239 sole outbox claim and provider receipt, including verified /share/→private editable /c/ destination. No second notification sender.
- [ ] T022 Real headed E2E worker→independent-reviewer→owner notification→same-worker correction→new owner round→approval→A-only window close, with actual provider IDs, signed reports and Issue B unaffected.
- [ ] T023 Verify reviewed #225/#227 compatibility SHAs and actual combined merged code; no blind stale cherry-pick, overwritten signed state, unauthorized branch merge or premature original Issue closure. #239 stays OPEN until entire product user journey passes.
- [ ] T024 Exercise busy owner chat, multiple owner registry entries, private /c/ and /share/ navigation, post-submit ambiguity, multi-round changes_requested; CLI stdout or ledger enqueue alone never count as delivered owner notification.
- [ ] T025 Legacy Production-profile safe handoff acceptance: inspect exact existing process/socket/profile/worker ownership read-only and reconcile saved Issue #226 ambiguous turn 6 or report explicit blocker. No reset/kills/replay of #214/#226.
## Explicit handoff to other Issues, NOT implementation here

- [#241](https://github.com/EmporioBreak/DevOS/issues/241) — worker account-chat deletion and retirement.
- [#242](https://github.com/EmporioBreak/DevOS/issues/242) — multi-Issue Runner scheduler/worktrees/cleanup.
- [#243](https://github.com/EmporioBreak/DevOS/issues/243) — replaceable Main Agent Chat.
- [#244](https://github.com/EmporioBreak/DevOS/issues/244) — project heartbeat, queued issue admission.
- [#224](https://github.com/EmporioBreak/DevOS/issues/224) / PR #225 and [#226](https://github.com/EmporioBreak/DevOS/issues/226) / PR #227 — keep original Issue/PR/worker ownership and REUSE code; do NOT declare #239 complete unless both are actually integrated and verified in real signed-in end-to-end flow.

**No** deleting ChatGPT chats, task worktrees, installing additional project clients, spinning a generic scheduler/cron, switching Main Agent ownership, or retroactive cleanup of any #214/#224/#226/#232 state within #239.
