# Implementation plan — adapt CoS, retain DevOS ownership boundaries

**Issue:** #239 | **Upstream CoS SHA:** `9c9ccac195be282011a5e7c8f2ee35e64f8680b7`
**Status:** draft architecture for exact owner review; no code production swap by this document.

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

The **explicit candidate graph** lives in `workflow.draft.json` and `skills-roster.draft.json` in this same Issue artifact directory; six total declared workers, including one exceptional local E2E fallback only on independently proven missing browser-host capability. Main Agent predeclares and signs the full graph with all real skills before Runner. A local host developer starts because actual process/profile/IPC controls are absent from the browser MCP interface; this is a specific verified action need, not an automatic task-category rule. An independent local security auditor, native process QA, live ChatGPT browser QA and separate reviewer follow. Browser QA can route to its **already declared** Codex fallback only under signed needs_local_worker + trusted host proof. Any changes_requested route returns to the SAME original developer, Issue and PR, with no regenerated worker sessions. The graph owner is Main Agent, not a worker role.

These files are **drafts**. Neither a checked-in graph nor model-authored digests constitute owner approval; Constitution, original Spec Kit and this exact skills roster must be reviewed in DevOS's owner password-backed task approval flow before executing a post-migration task.
