# Implementation plan — bounded CoS browser broker for DevOS

**Issue:** [#239](https://github.com/EmporioBreak/DevOS/issues/239) · **Draft PR:** [#240](https://github.com/EmporioBreak/DevOS/pull/240)
**Pinned upstream CoS:** `9c9ccac195be282011a5e7c8f2ee35e64f8680b7`
**Status:** DRAFT reduced scope, **not** a signed owner/graph approval or Production rollout.

## Integrated production-delivery contract — #226 + #224 + #239

#239 is the **browser-worker product integration and final acceptance gate** for three existing original Issues/PRs, NOT a second implementation of their features:

| Original ownership | Existing branch PR / proven work | Actual missing acceptance | Integration responsibility |
| --- | --- | --- | --- |
| [#226](https://github.com/EmporioBreak/DevOS/issues/226) | [PR #227](https://github.com/EmporioBreak/DevOS/pull/227): one shared Camoufox/profile and one Issue window with worker tabs; isolated real empty-profile Camoufox smoke, unit regressions | Safe real retained legacy #214/#226 profile adoption without replaying the ambiguous #226 turn 6, and genuine authorized Production two-Issue window E2E | Reuse existing `shared-browser-runtime`/`chatgpt-browser-executor`, preserve per-Issue leases; resolve real host blocker only through original task authority. |
| [#224](https://github.com/EmporioBreak/DevOS/issues/224) | [PR #225](https://github.com/EmporioBreak/DevOS/pull/225): password/HMAC-bound owner target, persistent per-review-round notification intents, enqueue in CLI; source/full suite reported green | Real user-role native owner notification Send, correct authorized `/share/`→original writable `/c/` binding, busy/idle and provider receipt; real headed E2E | Reuse its exact `OwnerWakeupLedger`, `owner-wakeup-handoff`, `owner-task-approval`; adapt its intent API to #239's ONE outbox, not another independent sender. |
| [#239](https://github.com/EmporioBreak/DevOS/issues/239) | [PR #240](https://github.com/EmporioBreak/DevOS/pull/240): identity matcher and canonical draft | Durable one-shot browser command claim, provider receipt/ACK, document epoch, compatibility/migration and complete end-to-end verification | Provide the ONE command/Send transport for **both** worker and existing #224 owner messages, preserving #226 profile/window owner. |

**Implementation phases are dependency-driven, not three disconnected "done" stamps.** First audit the CURRENT source diffs and latest accepted signed owner states of #225/#227; make an API/ownership map and verify which commits/changed files are already on each branch/main. Next reconcile the #226 live legacy profile safely; NEVER launch a second profile, kill #214, clear the activeReport or retry ambiguous turn 6. Implement the #239 command broker at the actual Send/owner-notification boundary and unify the existing #225 enqueue intent, #227 runtime/window ownership and one source of truth for claim/ACK. Land code with controlled Main Agent-reviewed Git integration (no unsupervised new worktree, stale blind cherry-pick or competing branch edit), preserving each existing Issue's signed worker/PR lifecycle.

**Gate the release on one real signed-in headed user journey**: two authorized Issues/windows/tabs on the existing profile; worker prompt with provider outgoing message ID and signed MCP report; independent reviewer reaches `final_review_required`; #224 sees authenticated current Main Agent idle, navigates from approved saved `/c/` or verified `/share/`→private editable `/c/` and truly posts one visible normal user-role notification with provider receipt; Main Agent changes_requested returns to SAME Issue worker chat/window/PR; second review round sends one fresh notification; genuine approved A closes only A's window, B remains. Verify full combined-code tests, crash/ACK and recovery, signed reviewer evidence, security, live legacy-context safety and owner final product acceptance. If any phase cannot be proven, #239 remains OPEN/BLOCKED, and **the browser feature is not shipped** even if all three individual mock suites pass.

**Original PR governance:** Do not abandon or prematurely close #225/#227 or declare their Issues completed because #240 references them. Maintain owner-approved frozen worker graphs, pending turns and original PR review discussions. They may be merged when their actual original acceptance gates are independently satisfied and when the integrated code dependency is verified; #239 is the final release gate for combined behavior. Avoid duplicating work under #240 when reusable source exists. When an integration API contract requires changes to upstream PR, route through its already approved same-Issue graph/owner gate rather than silently rewriting it. The exact merge order must be resolved against real branch commit ancestry, verified compatible code and Main Agent approval, not assumed here.

## Predeclared execution and genuine host-visual E2E capability

**Five planned `codex` workers, not a browser-first E2E fallback:** (1) implementation in an isolated Codex session, (2) independent security audit, (3) independent native process/IPC fault QA, (4) **separate macOS GUI/Computer-Use visual E2E QA** observing and interacting with the existing approved Camoufox profile, (5) separate independent final source/evidence review. Every `changes_requested` returns to the original developer and existing PR #240 and re-runs affected tests. #224/#226 exact original signed graphs are unchanged. No ChatGPT browser worker is assigned to a visual E2E it cannot execute.

Before headful visual QA the local Codex worker probes actual available macOS window/pointer/keyboard/screen-inspection permissions, authorized provider/account/login, and task/browser ownership. Host preflight on 2026-10-11 found `/opt/homebrew/bin/codex`, `osascript`, `screencapture`, `swift`, `xcrun`, an active macOS console user and Playwright Core dependency — this is **tool availability only, not GUI-control permission or a passed test**. No headless/DOM-only assertion may satisfy the user-required real interactive test; the QA worker must actually inspect screenshots/video and operate the UI on safe disposable authorized tasks, with genuine provider outgoing message IDs and signed MCP reports. If visually operating the existing authorized Camoufox is impossible, return a specific truthful blocker rather than launching another profile, replaying a turn or silently replacing acceptance.

This is a **material change** from the earlier six-role browser-first draft; the previous owner-approval form was tied to an obsolete SHA/roster. Refresh SHA-bound original Spec Kit/full immutable five-role graph/skill digest in the real owner-password approval system before Runner. Until verified, all activities remain read-only planning.

## Implementation boundary and implementation order

1. Retain the ONE installed project's original authorized Camoufox/profile and its existing #226 Issue-window semantics; inventory current profile/PIDs and ambiguous submitted worker turns **read-only** before any native browser action.
2. RED-first adversarial identity tests (current pure matcher exists), then **one canonical persisted command/outbox** with immutable project+Issue+worker+turn+graph+payload, runtime/profile/window/tab/document/navigation lease and exclusive claim-before-Send.
3. Central provider observation/DOM adapter and native command receipt from the original user-message ID; do not treat a Playwright click, unsigned textual reply or process liveness as provider delivery or signed worker completion.
4. Integrate only existing worker MCP approval and task-saved Project conversation; across review corrections resume the same Issue chat. Do not import CoS sleeping agents or repurpose a chat for another Issue.
5. Migrate existing volatile send caches only when their real active ownership can safely be reconciled. Wire #224's **existing signed owner-notification intent and delivery workflow** into #239's single browser command/outbox as the only Send authority, using #226's process/window/session leases. #239's product acceptance REQUIRES a real owner message receipt; it must not create another notification sender or claim that #224's queue alone is delivery.
6. RED/GREEN crash/restart/receipt-ACK/no duplicate/native window tests, full combined #225+#227+#240 regression, actual signed-in headed worker→reviewer→owner notification→changes_requested→same worker→approved→A-only close E2E, independent security/code review, then owner acceptance and gated opt-in rollout. Do not replay old #226 turn 6 or alter paused #232.

## Related capabilities explicitly moved OUT of #239

**Agreed, not canceled:** [#241](https://github.com/EmporioBreak/DevOS/issues/241) (worker retirement and provider chat deletion); [#242](https://github.com/EmporioBreak/DevOS/issues/242) (parallel project-local Runner scheduler, temporary managed worktrees and one independently installed client per project); [#243](https://github.com/EmporioBreak/DevOS/issues/243) (Main Agent active chat handoff; GitHub is project knowledge source); [#244](https://github.com/EmporioBreak/DevOS/issues/244) (bounded local heartbeat and admission of only preapproved queued Issues). Existing [#224](https://github.com/EmporioBreak/DevOS/issues/224) owns final-review notifications; [#226](https://github.com/EmporioBreak/DevOS/issues/226) owns existing shared-window groundwork. Their PRs, signed sessions and implementation remain unchanged by this separation.

These follow-up Issues need **their own** original Spec Kit, owner-signed exact full graph/skills and evidence. Do not treat #239's draft six-worker graph as automatic authorization for any of them. No full ChatGPT worker deletion, concurrent code worktree creation, heartbeat, scheduler, owner chat handoff or new installer is in #239's executable scope.

## Architecture decision

**Do not install CoS alongside DevOS.** Its full Electron+Chrome/Edge/Brave MV3 extension + HTTP bridge would become a competing browser/process/session owner and does not directly support the existing Camoufox/Firefox profile. Instead use CoS's precise ownership, outbox, durable command ACK, broker and observation contracts to rebuild the existing DevOS browser subsystem behind its unchanged `Executor`/signed-MCP interfaces.

**One ledger, one broker, multiple adapters.** Central `BrowserCommandStore` owns durable, task+turn+document fenced commands; project `BrowserBroker` owns profile/windows/tabs; the existing `ChatGptBrowserExecutor` becomes a transport-specific adapter, initially Camoufox. Optional Chromium extension adapter is a future separately approved migration with authenticated permissions/provider terms verification; never silently migrate the profile. `owner-wakeup-ledger` (currently Draft PR #225) and shared-browser in-memory `turns` (Draft PR #227) must be **consolidated**, not stacked as independent send authorities.

## Boundary map

| CoS source and behavior | Current DevOS source / gap | Adaptation |
| --- | --- | --- |
| `src/main/session/input.ts` durable outbox, authored input IDs, single exclusive claim and provider receipt | `src/chatgpt-browser-executor.ts` POST observation; `src/orchestrator.ts` activeReport JSON; `src/shared-browser-runtime.ts` in-memory per-turn cache | Central command store under `.devos` with exact signed turn key, pre-send claim, post-send provider ID, ACK and unknown state; retire duplicated volatile send owner after migration |
| `src/main/bridge.ts` command records and receipts, ACK custody before retirement | Separate detached browser process IPC; no persistent document command lease | Exact IPC envelope with command ID, task, worker, worker turn, runtime incarnation and document epoch. Replay returns original receipt/status; never sends a new prompt |
| `extension/background.js` MV3 tab/document registry, opening authority spent at handout | `src/shared-browser-runtime.ts`, `src/chatgpt-browser-executor.ts` windows/pages | Durable window+tab owner table; never open replacement after unknown list or manual close; no global teardown |
| `extension/content.js`, `fiber.js`, `chatgpt-dom.js` bounded page observations and selector isolation | `src/chatgpt-browser-executor.ts`, `src/chatgpt-dom-recovery.ts` | One DOM adapter + exact immutable same-document evidence with navigation epoch; don't trust unverified page-world data as tool/owner permission |
| `src/main/agents.ts` durable family/worker provenance and sleeping worker reuse | `src/workflow.ts`, `src/orchestrator.ts`, `src/chat-worker-grants.ts`, `src/json-state-store.ts` | Reuse its scoped identities, inbox/report receipt fences only. Preserve DevOS pre-approved immutable worker graph, no runtime spawning or Cross-Issue text rerouting |
| `src/main/session/continuation.ts` A→B WAL | DevOS persisted same worker session, retries/review loops | Explicit lineage and transactions if planned session replacement is ever approved; missing original chat must not auto-create B |
| CoS Goal/Loop and command recovery with one bounded owner | `src/browser-recovery-policy.ts`, `src/chatgpt-turn-recovery.ts`, `src/owner-wakeup-ledger.ts` | One bounded recovery obligation; read-only message recovery if submission is uncertain, no duplicate Send; preserve present owner conversation |
| CoS Chromium `browser-control` + extension | DevOS Camoufox (Firefox) | Adapt protocols, **not** MV3 binaries; gated future adapter after separate security and sign-in checks |

## Delivery protocol

1. Admission: confirm signed DevOS Issue/worker/turn grant, saved session and project scope. Persist immutable intent with payload digest and incarnation.
2. Claim: atomic, one-time lease against current project runtime/profile/document owner. Opening/Send authority consumed *before* native side effect. Another process sees claim as blocked, not absent.
3. Observe: current verified window/tab/document/epoch, URL, editable composer, current authenticated account/protection and busy/generation status. Reject foreign/stale evidence. No tab creation based on uncertain query.
4. Perform: one native UI operation in task window. A timeout during/after click is **unknown**, not safe to repeat.
5. Receipt: exact provider-origin user-message ID + immutable conversation and matching command/prompt evidence, persisted before any ACK or UI success claim; verify assistant final separately. Missing/conflicting receipt remains ambiguous; only read-only reconciliation may settle it.
6. ACK: idempotent retrieval and bounded custody retention; processor crash never refunds spent authority.
7. Cleanup: only exact terminal-approved task window/tab, never whole shared profile while another live lease exists.

## Backward compatibility and migration

- Inventory `.devos/state/*.json`, task/browser metadata, real old Node PID/identity/socket, shared profile and all known conversations **read-only**.
- Quiesce/adopt only when every old command has a verified terminal status or preserved explicit ambiguity and no live old runtime can independently relaunch the profile. On unverifiable state refuse a second context; don't kill legacy and don't report green E2E.
- New protocol opt-in only for newly approved work. Existing #226 ambiguous turn 6 stays unchanged. Do not use a new Staging connector, cookie export, second profile or test reset.
- Migration from old per-task runtime to shared project broker must be transactional, preserving original GitHub PR/worker identity and signed MCP credentials.
- Feature flags are deploy gates, not independent second authorities; rollback must preserve spent Send/command receipts.

## Tests and independent sign-off

RED/GREEN at API, IPC, Playwright DOM-adapter, PID/profile and signed MCP boundaries. Include concurrency and crash injections; a missing visual/UI tool is a truthful blocker, not a shell surrogate. Real headed two-window E2E requires explicit safe legacy compatibility and an approved provider usage posture. Independent review inspects pinned original spec+plan, diff, provenance, logs and provider receipts, then Main Agent decides.

## Licensing / responsible use

Upstream CoS is MIT licensed (see `LICENSE` at pinned SHA); preserve copyright/LICENSE for copied/substantially derived code. This plan describes architecture; it does not copy their implementation. CoS's own README/SECURITY explicitly warn that browser/UI integration is not a public ChatGPT API, may conflict with provider rules and must not bypass usage, auth or safety restrictions. DevOS will not silently enable automated scraping/recording or transfer auth cookies. Review OpenAI terms and authorized account constraints before activating new browser instrumentation.

## Draft full worker graph (not signed, no Runner dispatch)

The **explicit candidate graph** lives in `workflow.draft.json` and `skills-roster.draft.json` in this same Issue artifact directory; five total declared workers, all Codex: developer, security auditor, native host QA, genuinely interactive macOS visual E2E QA, and independent Codex reviewer. Main Agent predeclares and signs the full graph with all real skills before Runner. A local host developer starts because actual process/profile/IPC controls are absent from the browser MCP interface; this is a specific verified action need, not an automatic task-category rule. An independent local security auditor, native process QA, live ChatGPT browser QA and separate reviewer follow. Browser QA can route to its **already declared** Codex fallback only under signed needs_local_worker + trusted host proof. Any changes_requested route returns to the SAME original developer, Issue and PR, with no regenerated worker sessions. The graph owner is Main Agent, not a worker role.

These files are **drafts**. Neither a checked-in graph nor model-authored digests constitute owner approval; Constitution, original Spec Kit and this exact skills roster must be reviewed in DevOS's owner password-backed task approval flow before executing a post-migration task.
