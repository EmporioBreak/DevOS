# Implementation plan: guarded worker-send readiness and durable background queue

**Issue:** #232. **State:** DRAFT, requires signed original Spec Kit plan and exact worker graph approval.

## Alternatives considered
- A. Click button with a longer timeout and re-run failed turns: REJECTED, risks duplicate submission and does not identify busy account.
- B. Poll arbitrary Main Agent chat UI from sidebar and assume target ready when it stops animating: REJECTED, privacy invasive and no genuine account-wide provider proof.
- C. Signed task-bound durable queue, read-only target readiness probe, independent receipts and project-local bounded Runner: SELECTED. Honest `global_busy_unknown` unless a real provider signal is verified.

## Execution architecture
1. Main Agent pins exact original feature spec/plan/tasks and complete worker graph including independent QA. Local implementation is *preplanned* as host capability required because live retained legacy Camoufox profile is currently owned by #226/#214; browser-first would collide with it. Reviewer independently verifies code and tests without altering active Production processes. No runtime route reassignments.
2. Isolate readiness probe in `chatgpt-browser-executor`: trusted saved-URL navigation only, explicit DOM state for target's active generation/Stop control, enabled composer, enabled send and overlays; stable two samples, bounded poll. Define strict reason categories; do not use `isVisible()` as `can send`.
3. Implement a private per-task persistent send-intent/lease record with repo, Issue, worker, turn, prompt digest, signed graph identifier and saved conversation fingerprint. Exclusive lock plus atomic durable writes. Keep task lifecycle canonical `running`, attach send substates without mutating old signed graph. Audit without logging prompt, URL or OAuth secrets.
4. Project-local Runner background wait with bounded exponential backoff/jitter (not a global daemon) and safe wake scheduling. Persist deadline, attempt state and cancellation; lock/reconcile on restart. Avoid the Main Agent chat waiting for a tool response before the worker can send.
5. Separate `not_armed`, `preparing`, `armed`, `submitted_confirmed`, and `submission_ambiguous` transport phases. Persist pre-click intent, observe exact outgoing message ID or signed terminal MCP report. On click timeout, use read-only exact-turn reconciliation; if proof absent stop without replay, even if later UI appears idle.
6. Integrate with existing `JsonStateStore`, `SharedBrowserExecutor`/Camoufox process and strict signed graph. Ensure #226's pending ambiguous turn does not get retried as a side effect. No profile copy or replacement browser session.
7. Real RED→GREEN tests at unit, integration and concurrent process level; project background wait with Main Agent no longer generating; real headed browser E2E only against permitted controlled test conversations. Require no unsafe reliance on guessed provider busy API.
8. Independent reviewer checks exact evidence and sends `changes_requested` to original developer in same PR when necessary; only Main Agent may approve/merge/deploy after real E2E and regression proof.

## Detailed safety gate
- Early wait/readiness failure is provably pre-submit ONLY if no composer/input/click or pending send mutation ever occurred.
- Once an actual click/keypress attempt begins, an undecidable send is ambiguous and must be held. A lack of POST observer ID is not a `not_sent` certificate.
- No auto retry of any original #226 pending request. No background job should consume a completed or unapproved worker graph, or resume cancelled task leases.
- `global_busy_unknown` is exposed honestly; success criterion depends on *observable* target readiness, not conjectured state of another user chat.

## Proof and rollout
Build and all relevant tests, postrestart/chaos stress, real two-chat E2E; independently signed code review. During implementation use one normal feature branch in the sole Production checkout. Do not merge or restart MCP automatically. Preserve existing runtime until verified safe migration path for #226 is separately ready.
