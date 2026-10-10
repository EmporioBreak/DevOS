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

## Parallel work safety
- #232 explicitly must not be touched.
- #224/#226/#228 existing PR and exact chat/session states stay unchanged until separately reconciled; this Issue is not a back door for replay of #226 turn 6.
- No second Production/Staging MCP, browser profile, custom system daemon or cross-task worker authority.
