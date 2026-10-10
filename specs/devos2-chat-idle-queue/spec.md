# Feature: durable, evidence-based ChatGPT worker-send readiness queue

**Issue:** EmporioBreak/DevOS #232
**Original Spec Kit feature stage:** DRAFT, not owner-attested; exact graph and skills require independent owner approval before Runner implementation

## Problem / observed baseline
- In current #226 PR #227, owner `changes_requested` resumed the original browser developer, but the send-button `locator.click` timed out after 15 seconds. No outgoing ChatGPT user request ID was captured; DevOS conservatively retained an ambiguous may-have-submitted turn 6. Owner confirms no message is visible. Neither absence in the UI nor click timeout is definitive backend proof of a safe retry.
- ChatGPT may be serving another active Main Agent response. There is no independently verified account-wide busy/idle provider API. A target chat's visible send button does not establish that it is enabled, unobstructed, stable, or that the broader account is idle.
- A synchronous Main Agent tool call cannot wait for the assistant's own response to end; waiting and work delivery must be owned by a bounded project-local Runner, not the owner chat or an OS daemon.

## User stories
1. As an owner, while I am interacting with Main Agent, DevOS queues a new worker message and sends it only when it has trustworthy evidence the target worker chat is ready, without me saying “Готово”.
2. As a worker, I receive no more than one copy of my exact task/turn prompt even if UI state changes mid-click or the Runner disconnects.
3. As a Main Agent, I can see whether a turn is waiting for the target chat, has been confirmed as submitted, remains ambiguous, or is blocked after a finite deadline.
4. As a security reviewer, I can prove that an unrelated ChatGPT conversation, Issue, Project or expired MCP authorization cannot gain a send lease or cause a retry.

## Functional requirements
- FR-001: Derive target worker conversation only from the signed, existing task+worker assignment and exact saved conversation/Project. No sidebar discovery, guessed URL, replacement conversation, new profile or use of unrelated user chats.
- FR-002: Separate **read-only readiness observation** from **submission evidence**. Pre-send observation of the exact target verifies project and conversation identity, absence of active generation or Stop control, enabled composer and enabled visible send control, absence of blocking overlays/login/challenges, and stability across multiple observations. Check the send control again before action. Visible alone is insufficient.
- FR-003: If a trustworthy account-wide Main Agent turn-busy signal is available, use a verified, bounded, correctly authenticated observation. Otherwise expose `global_busy_unknown`: target-chat readiness does not prove Main Agent is free, and product MUST NOT promise guaranteed detection of another conversation finishing. No fake cross-tab signal or guessing from elapsed time.
- FR-004: Maintain a private durable, task-scoped queue record for exact `(repo, issue, workerId, turn, prompt SHA-256, saved conversation identity, immutable signed graph)` and a machine-readable substate of canonical `running` (not a new task lifecycle status): `waiting_for_chat_idle`, `ready_to_send`, `submission_pending`, `submitted_confirmed`, `submission_ambiguous`, `blocked`.
- FR-005: Establish a single-writer exclusive lease for a saved conversation and turn across concurrent Runner processes before any composer fill/click. Persist intent before click using atomic write/fsync as appropriate. Leases must survive/reconcile crashes rather than expire into automatic duplicate send.
- FR-006: The *project-owned bounded background Runner* waits/polls with increasing bounded backoff and explicit total timeout, cancellation and restart recovery; it continues after Main Agent reply terminates without a new assistant turn or perpetual global LaunchAgent. `waiting_for_chat_idle` must not allocate a new worker turn or create another conversation.
- FR-007: Record `submitted_confirmed` only from exact outgoing POST request/user-message ID or a valid turn-scoped signed MCP report; probe may inspect exact conversation read-only. A button click, UI disappearance, or owner statement alone is never receipt of submission or definitive no-send evidence.
- FR-008: An error after click may be `submission_ambiguous` even with no captured POST. Never automatically re-send an ambiguous turn. Retry permitted only after independent *definitive* no-submit proof and a fresh single-send lock; unknown == blocked, not retry.
- FR-009: If current exact target never becomes ready before bounded deadline, persist blocked reason and return a precise failure for Main Agent decision; no unbounded busy loop, no repeated login prompts or provider 429 bursts.
- FR-010: Preserve #214 final-review state, #224 original signed graph, #226 existing ambiguous worker turn 6, all saved worker sessions and the original Production Camoufox profile. This issue MUST NOT replay #226, replace worker chats, disable authorization, force-close a task, create extra worktrees or restart Production.
- FR-011: Main Agent selects executor for each preapproved action by actual capability. Runner only executes the exact owner-approved signed graph; never infer routes from task category. Developer/reviewer must be independent; no self-acceptance.

## Non-goals / limits
- Do not claim ChatGPT exposes a reliable provider-level account-wide generation signal unless observed and attested through a supported interface. If unavailable, show this limitation, and fail closed when account-wide certainty is necessary.
- Do not solve old #226 process/window migration, #224 wake-up or #214 acceptance inside #232.
- Do not bypass a possible-submit ambiguity because owner saw no message; the original turn remains held for separate forensic reconciliation.

## Acceptance (all evidence classes distinguished)
- RED/GREEN exact busy/disabled/button-covered/readiness-stability tests: no composer mutation or send until stable; exactly one send after readiness appears, with same conversation and same turn.
- RED/GREEN race/crash/restart/lease tests: concurrent runners, ambiguous click/POST/response loss, MCP terminal report, still-generating target, account-busy known/unknown, backend rate limit, login and challenge all preserve dedupe and owner isolation.
- Running after Main Agent answer completes is demonstrated through an actual project-owned background process rather than assistant streaming or a mocked timer.
- **Real headed Camoufox E2E**: authorized two actual ChatGPT conversations, controlled active→idle transition with one real worker message; verify browser UI + backend receipt + exact worker handoff, without touching retained #214/#226 sessions. If genuine account-wide busy cannot be observed, state exact unsupported guarantee rather than faking E2E.
- Independent reviewer inspects actual diff, test output, original Spec Kit artifacts, persisted owner/turn identity and race recovery. Main Agent alone decides acceptance, not reviewer status alone.
