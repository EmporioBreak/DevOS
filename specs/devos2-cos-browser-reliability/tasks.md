# Task breakdown — CoS-derived DevOS browser reliability

**Issue:** #239 | **Status:** draft / no signed owner graph; **do not start Runner or active browser sends**.

## Pin and approve
- [x] T001 Read DevOS and CoS AGENTS.md, original CoS source and license; pin immutable `9c9ccac195be282011a5e7c8f2ee35e64f8680b7`.
- [x] T002 Document gap map, source boundaries and canonical Spec Kit spec/plan.
- [ ] T003 Main Agent assembles action/risk-specific full immutable team and actual skills by capability; user password-approves exact scope, original Spec Kit, git SHA/PR and graph; do not pretend text message is signed approval.

## One authority — test first
- [ ] T004 RED tests across payload/command/doc/owner/turn identity, A→B→A, same worker label from different Issues, stale runtime incarnation.
- [ ] T005 Introduce one transactional command/outbox state machine, strong idempotency and durable claim before side effects. Remove duplicated send owners as it becomes authoritative.
- [ ] T006 RED/GREEN crash injection at every claim/Send/receipt/ACK boundary; provider-origin receipt and read-only reconciliation; explicit ambiguous.
- [ ] T007 One project broker and scoped task-window/worker-tab leases, no global kill and no duplicate process even with idle legacy Node owner.
- [ ] T008 Integrate sealed worker grant, saved Project chat identity, exact IPC and bounded page/document observation; real owner-notification round uses same outbox, not separate mirror.
- [ ] T009 Bounded liveness, busy/idle/revoked/manual-close observations, no speculative retries; diagnostic events with redacted exact owner/phase.
- [ ] T010 Legacy live-context adoption or fail-closed blocker with saved #226 turn and no profile duplication; no #232 actions.

## End-to-end, review, rollout
- [ ] T011 Unit/model-based, simulated processes, IPC, crash/restart, multi-Issue adversarial and complete existing DevOS regression.
- [ ] T012 Genuine approved headed browser E2E with independent signed worker reports, two Issues/windows, turn message IDs, owner wake-up, review correction same chats, A-only close. No simulated E2E success.
- [ ] T013 Independent code/security/provider terms review; Main Agent final judgment, change requests same PR/Issue, no premature merge or Issue closure.
- [ ] T014 Document migration/rollback procedures, avoid legacy orphans and preserve CoS MIT attribution for any substantial port.

## Explicit Issue-scoped worker lifecycle (owner decision)

- [ ] T018 TDD: same Issue / same predeclared worker returns to same saved Project conversation after `changes_requested` and safe restart; a new Issue, including one reusing the same worker role/name, MUST get a new conversation, clean prompt context and separately signed grant.
- [ ] T019 TDD: only genuinely approved `completed` retires that Issue's grants, worker executable session mappings, tabs and window; no completed worker from A can receive a new turn in B; B's window/profile/MCP grants continue unharmed. Late worker reports, stale document epochs and ambiguous active sends cannot regain execution authority or be silently deleted.
- [ ] T020 Verify no CoS-style sleeping agent pool/reassignment, persistent cross-Issue worker memory, or auto-import of previous worker chats. Main Agent retains long-term project understanding; GitHub records remain as audit and task-handoff artifacts.

## Parallel work safety
- #232 explicitly must not be touched.
- #224/#226/#228 existing PR and exact chat/session states stay unchanged until separately reconciled; this Issue is not a back door for replay of #226 turn 6.
- No second Production/Staging MCP, browser profile, custom system daemon or cross-task worker authority.

## Destructive worker-chat cleanup after genuine Issue completion (owner request)

- [ ] T021 RED/GREEN: only accepted, merged-if-applicable, verified GitHub Issue `closed:completed` activates browser-worker chat deletion; active, changes_requested, waiting, cancelled, not_planned and disputed/ambiguous work MUST NOT delete anything.
- [ ] T022 RED/GREEN: task/worker-bound immutable original provider conversation ID + account/workspace/Project ownership proof required; wrong Issue, missing proof, borrowed URL, owner chat, manually created chat, similar sidebar title, same worker role in another Issue, cross-account navigation all fail closed.
- [ ] T023 RED/GREEN: one durable per-dialog deletion intent → exclusive destructive claim → actual authorized UI Delete + confirmation → authoritative account-deleted evidence. Simulate pre-click crash, click timeout, lost ACK, restart, duplicate cleanup request and provider account mismatch; never repeatedly click after a possibly successful Delete.
- [ ] T024 RED/GREEN: broker revokes task-grants and freezes active sends before destructive cleanup; preserve exact GitHub audit artifacts, but no full worker transcripts in local cleanup receipts. Delete only task A chats/window/temporary metadata; task B and shared Camoufox continue uninterrupted. Block cleanup if a possible outstanding send/worker report cannot be reconciled.
- [ ] T025 Authorized headed E2E: finish a disposable test Issue, verify original worker chats deleted (not archived) from the correct ChatGPT account, new Issue gets new chats, foreign/user/Main Agent chats remain; document provider retention limitations. Do **not** use #214/#224/#226/#232 conversations as disposable test targets.
- [ ] T026 Independent security review and owner approval for irreversible deletion path before enabling by default. On genuine unavailability show cleanup_pending/blocked and a bounded safe reconciliation procedure, not a misleading success.

## Parallel Issue execution and serialized Main Agent review (owner request)

- [ ] T027 RED/GREEN: a project-level scheduler admits multiple **independently owner-signed** one-Issue graphs; per-Issue priority/dependencies, persisted admission status, bounded configurable concurrency, fair waiting queue, no task state lost across process restart; never spawn an undeclared worker or reuse old Issue chats.
- [ ] T028 RED/GREEN: three-Issue interleaving (A running, B busy/generating, C blocked), same worker names in different Issues, task-local retry/failure, shared profile/one project broker/one window per Issue, no global deadlocks, no cross-Issue MCP/turn/tab ownership or starvation.
- [ ] T029 RED/GREEN: allocate one owned, bounded, temporary Git worktree per concurrently active code-writing Issue on its preapproved branch; persist exact task/path/branch/lease. Two different Issues edit/build/test simultaneously in separate trees, workers of one Issue share its tree; Production checkout/connector/Camoufox remain single, with no duplicate/nested/orphan trees or retroactive #232 cleanup.
- [ ] T030 RED/GREEN: simultaneous distinct `FINAL_REVIEW_REQUIRED` receipts enqueue one Main Agent user-role notification per Issue/reviewRound through the shared outbox; owner busy/generating defers delivery; delayed/out-of-order provider ACK, restart and coalesced status digests cannot lose or duplicate any Issue. Never fabricate a real `system` role or owner approval.
- [ ] T031 RED/GREEN: A changes_requested resumes its original worker chats while B is final-approved/merged/completed and **only B's verified DevOS-created worker chats** are deleted; C and shared Camoufox remain intact. Full E2E requires genuine headed observations and independent signed status.
- [ ] T032 Gradual live rollout proof: isolated one-Issue reliability, 2-Issue parallel, 3-Issue + Main Agent busy/owner wake queue, task-local deletion; independently verify throughput/backpressure, bounded memory and one shared browser profile. Without verified signoff do not activate Production parallel sends.

## Independently installed project clients and task-only cleanup (owner correction)

- [ ] T037 RED/GREEN: install/configure separate DevOS clients INSIDE two disposable Git projects. Each client is tied to exactly its own Git root/remote, integration branch, Main Agent, Runner/scheduler and local resource registry; neither client can discover or dispatch the other's Issues.
- [ ] T038 RED/GREEN: two clients on one host with equal Issue numbers and worker names have DISTINCT MCP auth bindings/endpoints, chat contexts, Camoufox process/profile, sockets, state and workspace permissions. Starting/stopping/updating Client A leaves Client B functioning without cross-client data or process access; collision fails closed.
- [ ] T039 RED/GREEN: inside ONE project's installed DevOS client, two approved coding Issues receive separate tracked temporary worktrees. After one completed/merged Issue, remove only its clean, task-owned tree/verified merged branch. Recovery after a crash reconciles only the current client's owned ledger; unmanaged/dirty/unmerged work is preserved with an explicit blocker.
- [ ] T040 Genuine disposable two-installation integration harness: Project A and Project B each install their own DevOS client; A runs two parallel Issues, B runs one with the same Issue ID and worker role as A. Verify independent Main Agents and broker/profile/MCP/runner state; merge/close/cleanup only A Issue #42 and prove A Issue #43 and B Issue #42 remain untouched. Do not launch a second connector within the existing Production project, migrate old live sessions or delete #232 resources.

## Preliminary safe preparation evidence (before owner-reviewed production wiring)

- [x] T015 Add isolated transport-neutral identity matcher and TDD RED→GREEN tests (not yet a trusted host observation or authorization oracle): exact project/Issue/worker/runtime/profile/window/tab/document/navigation epoch, A→B→A, signed-turn/command/payload/provider receipt IDs. `src/browser-command-identity.ts` is a pure matcher, not a second outbox, browser executor, signer or proof source.
- [x] T016 Build and run focused existing browser regression read-only with no active browser launches; 122/122 scoped tests pass, including the 3 new identity tests. This is NOT the real headed signed-in E2E.
- [x] T017 Produce explicit draft 6-slot task-specific worker graph and aligned skill roster. **These drafts are not owner approved** and must be pinned in the actual task approval.

## Managed temporary worktrees and mandatory cleanup

- [ ] T033 RED/GREEN: concurrent tasks A/B in arbitrary configured repositories create exactly one separately owned temporary worktree per repo+Issue, enabling independent edits/tests without switching that target repo's base checkout or the DevOS control-plane Production checkout.
- [ ] T034 RED/GREEN: after Main Agent acceptance, exact PR merged and GitHub Issue verified closed completed, quiesce task writers then remove only its clean, task-owned worktree and verified merged feature branch, leaving other Issues and main intact.
- [ ] T035 RED/GREEN: refuse destructive cleanup on dirty/untracked/ignored content, unmerged commits, active or ambiguous worker turn, wrong path/branch, foreign/symlinked workspace, incomplete GitHub closure; simulate crash/restart and idempotent cleanup without force pruning.
- [ ] T036 Actual disposable Git fixture E2E for concurrent create/edit/commit/merge/delete plus orphan detection, stable registry and limited quota; independent review and signed owner acceptance. Never retroactively remove old #232 or trusted legacy worktrees.
