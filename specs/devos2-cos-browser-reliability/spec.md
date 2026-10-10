# Feature: CoS-derived reliable browser workers for DevOS

**Issue:** EmporioBreak/DevOS #239
**Source benchmark:** https://github.com/totec448-spec/chat-on-steroids
**Pinned upstream:** `9c9ccac195be282011a5e7c8f2ee35e64f8680b7`
**Status:** DRAFT — not an approved original Spec Kit / worker graph; no production rollout authorized.

## Problem / user stories

DevOS workers sometimes remain stuck because the existing Camoufox runtime, worker conversation, detached process and attempted Send are observed by different owners. The model/user cannot reliably distinguish an alive process from an alive authenticated page, a pending promise from an actual provider-accepted turn, or an idle Main Agent chat from one currently generating. Repeated recovery risks two browser processes using one profile or resending a message.

- As the owner, I want DevOS to run concurrent Issues independently without assigning every worker to local Codex just because browser reliability is poor.
- As Main Agent, I want genuinely signed, final worker results, preserved PR and conversations, and exactly one task-scoped final-review wake-up for each approved review round.
- As a browser worker, I want to resume **the same** ChatGPT conversation after a crash or review correction, not start a new conversation because an unrelated tab stopped answering.
- As an operator, I want clear diagnosis distinguishing waiting on authorization, busy/generating, invalid chat/project, connection loss, lease mismatch, submitted-but-unconfirmed, completed and manually closed.
- As the user, I want browser/desktop/iOS capability claims backed by actual observations, not by running a shell command.

## Requirements (source-aligned)

FR-01 — Exact durable ownership: one canonical browser command/outbox authority per DevOS project; a command binds immutable Issue, worker, worker turn, approved graph version, profile/process owner, task window, worker tab/document/navigation epoch, conversation ID (if known), payload digest and transport incarnation. No runtime component can invent ownership from a title, tab position, hostname or repeated worker ID.

FR-02 — Durable delivery: persisted command prepared → uniquely claimed before open/Send → native action → exact provider message receipt → acknowledged. Queued, composer inserted, post-click, submitted and completed are separate facts. A lost ACK, process exit or ambiguous send **does not authorize retry**. Provider read-only reconciliation can confirm the original message; conflicting/duplicate message IDs block.

FR-03 — Browser lifecycle: one shared persistent Camoufox profile/OS browser root **per project**, one top-level window per eligible Issue, and worker tabs scoped to the correct Issue window. Only task A final approval closes A; B stays intact. Profile ownership and possible old Node process relaunch are checked before any browser launch. Preserve and safely adopt existing trusted legacy sessions without kill/reset/copied profile.

FR-04 — Conversation continuity: existing Issue+worker → same saved Project conversation; new Issue+worker → fresh Project conversation; user-created private chats cannot be inferred through sidebar traversal. Browser user auth and MCP grant remain distinct. Revoked grant can never be inherited by a new chat.

FR-05 — Browser evidence: one bounded provider DOM adapter owns selectors and structured observations; document id + navigation epoch + exact conversation must match before any mutation. On A→B→A navigation, stale A callbacks cannot send. A tab listing error is unknown, not zero tabs. Human/active draft/safety/restriction/verification screens stop automation.

FR-06 — Worker report and review: signed MCP status is terminal authority; no fake textual status. Browser worker active generation/tool work renews a bounded wait, but page presence does not. Preserve same chats/PR on changes_requested. Main Agent alone approves. Runner graph and signed skills frozen; **do not import CoS dynamic agent spawning or account switching**.

FR-07 — Main Agent notification: one task/review-round command after durable final_review_required, exact signed owner-chat fingerprint, verified private editable original /c after /share redirect, bounded busy/idle waiting and send provider receipt; never notify while chat is active and never forge owner approval.

FR-08 — Observability/recovery: structured bounded, redacted events for ownership, claim, browser process, document, receipt and final status. Restart reconstructs only previously committed facts. Recover or reload only when a corresponding exact obligation authorizes it; manual close never causes automatic re-opening. No unbounded retry daemon/watchers.

FR-09 — Backward-compatible security: no second connector or browser profile, no credentials copied or extracted from browser, no provider protection bypass, no hidden account switch, and no automatic coercion of unknown provider API. New adapter is opt-in and must not change outstanding #214/#224/#226/#232 signed turns during rollout.

## Acceptance examples

A. Two independently signed Issues have distinct window leases, worker tabs, conversations and MCP grants within one Camoufox profile/process; cleanup A cannot remove B.
B. Crash at each prepared, claimed, post-click, provider-receipt and post-ACK boundary is safe; at most one native Send **attempt** per exact command ID, even after restart.
C. User message ID and exact conversation ID match the originally claimed command before reporting sent; provider final/result is independently observed, not derived from a click.
D. Multiple changed browser tabs, including A→B→A, stale callbacks, same worker names, overlapping review turns and user-closed tabs never cross ownership.
E. Saved ambiguous turn 6 of #226 is preserved; new logic cannot replay it or launch a second profile. Verified read-only recovery or explicit irrecoverable blocker is visible.
F. Main Agent busy → notification stays pending; original private writable chat verified → one message; after ambiguity → no duplicate; changes_requested makes a new review round, not a new worker chat.
G. Real headed Production ChatGPT E2E, independent security review, full build/tests; a mocked Playwright case does not substitute.

## Explicit non-goals

- Installing CoS Electron app as a second DevOS orchestrator.
- Loading its Chrome/Chromium MV3 extension into Firefox/Camoufox as-is.
- Circumventing provider automation policies, restrictions, model access, rate limits or auth gates.
- Automatically transferring ChatGPT session cookies or recording arbitrary private chats.
- Changing #232, retiring #214, silently modifying #224/#226 PRs, or reopening possibly submitted prompts.
