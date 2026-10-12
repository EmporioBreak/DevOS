# DevOS dynamic agent runtime: implementation status and safety contract

Issue #246 / Draft PR #247. Experimental library code only. It is not a Production replacement for the currently approved legacy Runner. No current task is silently migrated.

## Present on this branch

- `src/dynamic-agent-runtime.ts`: policy-scoped agent directory, direct peer and Main Agent addressing, dynamically admitted agents, session identity binding, CoS-style atomic message batches, MCP tool inbox offer/reoffer and next-call ACK, bounded waking slot reservations, separate post-provider authenticated worker liveness, authenticated two-phase spawn intent/bind, idempotent work-unit finish/sleep, idempotent per-recipient queue, synchronous durable acceptance, cross-task protection, owner-only final decision and claim-before-provider-send fence.
- `src/dynamic-agent-bootstrap.ts`: CoS-derived two-phase worker bootstrap adapter; host-verified reservation, claim-before-provider session creation and exact authentic session binding. Unknown bootstrap outcome remains fenced.
- `src/dynamic-agent-scheduler.ts`: bounded, on-demand, graph-free queue-drain pass; other agents progress even when one recipient has an ambiguous send. It requires authentic recipient sessions and does not poll indefinitely.
- `src/dynamic-agent-policy.ts`: owner-MACed, immutable, exact-SHA v2 task policy; `sealedDynamicPolicyVerifier` provides a real fail-closed `verifyPolicy` callback, unlike mock-only authorizations.
- `src/dynamic-agent-devos-executor.ts`: adapter to the **existing** DevOS `Executor.run` contract for native Codex and Camoufox bootstrap, ordinary worker messages, and exact saved-thread/chat wake. Actual provider receipts and worker grants still require independent host evidence.
- `src/dynamic-agent-lock-recovery.ts`: maintenance-only recovery after proved writer death with an externally supplied exclusive-recovery guard; includes real child SIGKILL tests. Does not replay uncertain provider commands.
- `src/dynamic-agent-wake.ts`: COS-derived exact-chat wake command claim/receipt and unique per-wake identity, separate from normal worker Send.
- `src/dynamic-agent-dispatch.ts`: narrow host-verified dispatch seam requiring existing exact saved recipient session and an independently checked provider-receipt callback. It deliberately does not synthesize ChatGPT user-message IDs, create new browser contexts, close task windows or auto-retry ambiguous sends.
- Dedicated tests for peer-to-peer routing, dynamic QA/security, frozen session binding, admission and policy denial, task isolation, ordered delivery, crash/ambiguous replay barriers, host transport and final Main Agent judgment.

See `docs/cos-source-port-map.md` for the pinned CoS source-to-DevOS function correspondence and missing integration, and `third_party/licenses/chat-on-steroids-MIT.txt` for upstream attribution.

## First native browser E2E: current implementation boundary

The first end-to-end test now has a **browser-only, explicit, runnerless** composition point:
`src/dynamic-agent-first-e2e.ts` constructs the broker, bootstrap, normal
dispatcher, wake dispatcher and bounded scheduler using an **injected, existing**
DevOS `ChatGptBrowserExecutor`. Its `DynamicBrowserE2EHost`
(`src/dynamic-agent-browser-e2e-host.ts`) prepares task-pinned requests and
collects only **host-confirmed** original provider user-message receipts.

Implemented first-E2E protocol:
- First worker prompt calls `devos_worker_probe` **only**; provider-authoritative
  history proof atomically binds the preclaimed spawn to its actual new ChatGPT
  session and issues a separate v2 grant. No password, no user-initiation receipt,
  no second chat on ambiguous bootstrap.
- `WorkerRequest.dynamicTurn` and `waitForDynamicBrowserTurn` separate bootstrap
  authorization from the work-unit `finish`; **v1 `reportTurn` remains untouched**.
- `exactProviderAcceptedUserMessage` and the read-only browser verifier
  validate that the exact outgoing user message ID and whole submitted prompt
  exist in the original provider's chat history; outbound POST, DOM and assistant
  reply are not acceptance proofs. `DynamicDevosExecutorAdapter` matches the
  native proof against a second host-side command/recipient/session ledger.
- A real provider wake ACK is recorded during the running browser turn, **before**
  the worker may finish. The first subsequent authenticated `devos_agents_v2`
  request proves wake liveness and acknowledges previously accepted inbox
  messages, unblocking subsequent turns in the same chat without replay.

**This is an integration seam with mocked-provider tests, NOT evidence of a
successful headed/signed-in E2E.** It has not been executed against real
ChatGPT worker conversations. The native host must still supply the
authorized existing Camoufox owner, true signed task policy, live task lock,
actual main-agent session fingerprint and real browser authorization. Never
run it against in-flight v1 tasks or unowned/ambiguous profiles.

Acceptance journey for the first headed E2E: an isolated test Issue and
preauthorized task policy, fresh Developer and QA worker conversations in
the configured ChatGPT Project, initial proof and v2 grant in each, Developer
sends directly to QA, QA requests a correction directly from Developer,
Developer resumes the **same** chat, QA confirms the result, and Main Agent
receives the independent report. Verify every observed provider user-message
receipt and original session URL, no duplicate sends and no owner-password
form for v2 workers. Do not call a synthetic/in-memory journey a live E2E.

## Host verification requirements (not implemented by this library)

A production caller must wire `DynamicTrustBoundary` to actual trusted gateway facts rather than model-authored fields:

- `resolveCaller`: authenticated MCP session / exact saved ChatGPT or Codex identity and task owner.
- `verifyPolicy`: owner-authorized exact policy + scope and pinned skill manifests (not merely a string looking like a SHA256).
- `verifyNewAgentBinding`: verifies the newly created worker's actual session and task ownership. A worker's requested fingerprint is not proof.
- `verifyTransportLease`: host-owned lease on this exact task, agent and message, no role impersonation.
- `verifyToolCall`: authenticated subsequent MCP call from the exact recipient/session, with independently verified start time; never accept timestamps from a prompt.
- `verifySpawnLease`: validates host authority to create exactly the reserved worker session once.
- `verifySpawnNoStart`: independently proven no-bootstrap outcome, never a generic timeout.
- `verifyIndependentReview`: host-verified independent acceptance evidence, not a worker's self-reported approval.
- `verifyProviderReceipt`: real provider-accepted outgoing user-message or execution identity and task/turn correlation.
- `verifyNoSubmit`: independently proven pre-submit failure, not a timeout or model statement.

If any evidence is missing/ambiguous, the integration must reject or fence the operation. A `dispatch_uncertain` message must never be re-sent just because the original command timed out or a process restarted.

## Persistence and recovery

The new store lives at `.devos/dynamic/<encoded-repo>-issue-<issue>.json`, never reading or writing legacy `.devos/state` or frozen graphs. Its native lock records real process identity; transactions use exclusive creation, fsync and atomic rename. A SIGKILL leaves a denial-only lock. `recoverDynamicStoreLock` can release it **only** when a trusted coordinator proves exclusive quiescence and the original process is dead or has a distinct independently verified identity; corrupt locks fail closed. The real SIGKILL test covers one child and ordinary recovery. An automatic fenced recovery supervisor and race/host authorization E2E are still not implemented.

## Known unfinished integration / gates

1. Finish native host activation/run control for the first browser-only live E2E; the isolated `devos_agents_v2` MCP route already exists behind an OFF-by-default flag, but no production cutover/runner replacement exists; existing `Workflow(version:1)` and `Orchestrator` remain unchanged.
2. Execute the browser-only host through the existing native Camoufox runtime, without new profile/process/socket, and verify actual provider user-message acceptance. The adapter is connected by types and tests, but has no live E2E evidence.
3. Connect actual ChatGPT Camoufox worker identities, conversation wake/turn, provider receipts and original owner conversation, **after** #239/#224/#226 browser shared-custody gates are independently resolved.
3. Connect local Codex skill manifests and exactly one launch/receipt identity; test resumes without duplicate external commands.
4. Enforce real independent reviewer evidence gates and finish/merge controls at the Main Agent boundary.
5. Integrate trusted exclusive crash-lock recovery into the real native host supervisor; prove races between simultaneous recovery processes, owner revocation, power-loss and dispatch/ACK barriers. Mock/context/SIGKILL tests do not establish full E2E.
6. Run full DevOS build/test suite, independently review code/security and execute a signed-in real provider E2E on authorized disposable Issues. The local isolated TypeScript tests on this draft do **not** establish any of those gates.
7. Seek exact reviewed owner authorization and explicit staged rollout; v1 signed tasks must remain on their original executor until separately completed or safely migrated.

### Local isolated verification

GitHub Actions `Dynamic agent core checks` runs Node 22 `npm ci`, full repository TypeScript `npm run build` and the focused `tests/dynamic-agent-*.test.ts`. At [run #38219852828](https://github.com/EmporioBreak/DevOS/actions/runs/38219852828), build succeeded and **19/19 focused tests passed on the earlier cited revision** with mocked trust/transport providers. This is not the full DevOS test suite and not any real provider/browser E2E.

## Newer port revisions (after the cited 19-test run)

Added two-phase durable `requestSpawn/claimSpawnBootstrap/bindSpawn`, an isolated `DynamicAgentBootstrapper` and fault-injection tests; separated provider Send receipts from later verified agent liveness; require independent host evidence for final review; enforce unique saved conversations and agent principals; bound retained message history without discarding past idempotency evidence. The cited earlier run does not verify these newer commits; see the current PR CI result. Full test suite execution has been enabled in `.github/workflows/dynamic-agent-runtime.yml`, but must not be claimed green before its exact current-head completion. No Production transport has been attached.

### Later source-port milestones (PR #247)

- Added COS-monotonic 400k context-token ceiling; sleeping chats cannot be revived without a recent trusted context measurement and terminal work-unit reports retain the old conversation as a non-revivable fence. Real provider telemetry callback still needed.
- Introduced a real owner-MACed, SHA-pinned policy gate; unauthorized, mutated, wrong-PR and wrong-secret policies fail closed. This is an implementation API, not evidence that the owner has already sealed or authorized a Production task policy.
- Added DevOS Executor API adapter and tests for both Codex signed skill assignments and exact Camoufox Project/turn requirements; it cannot fabricate provider-accepted message IDs and is **not yet wired** into the live connector.
- Added real multi-process wake-claim and SIGKILL writer recovery tests. The existing v1 Production worker graphs/sessions have not been migrated.

Keep full-suite CI failure evidence separate from focused dynamic tests. The existing CI run #38222719646 had 631 passing, 8 failing, 5 skipped tests in full-suite legacy MCP/browser scenarios; whether those failures reproduce on `main` in the same runner remains unverified. Never describe this as full-suite green or real browser E2E.
