# Tasks: Dynamic Agent Runtime

**Issue:** #246 | **Status:** Proposed, not authorized for Production execution.  
Task ids denote implementable work/evidence, **not** a fixed worker execution graph.

## Baseline / architecture
- [ ] T001 Pin GitHub main and reviewed CoS source SHA; inventory existing Runner, MCP, browser, Codex and active task state without mutating them.
- [ ] T002 Define task policy, runtime version/compatibility selector and explicit trusted owner approval boundary; verify frozen v1 tasks remain unchanged.
- [ ] T003 Define typed AgentDirectory, MessageEnvelope, wake/ACK and unit-of-work state transitions, separately distinguishing queue acceptance from actual provider Send.
- [ ] T004 Create RED tests for direct worker->worker, worker->Main Agent and unplanned specialist admission; demonstrate current graph/CoS-star topology cannot satisfy intended behavior.

## New broker
- [ ] T005 Implement task-scoped identity and policy checks for send, spawn, work handoff and finish; prohibit caller-supplied authority.
- [ ] T006 Implement durable journal and transactional queue acceptance, causal/idempotency keys, scoped recipient inbox, bounded limits, event replay.
- [ ] T007 Implement sleep/wake/reuse of original worker sessions and verified Main Agent address; no chat substitution on uncertain identity.
- [ ] T008 Prove fault cases: SIGKILL at every acceptance/publish/dispatch/ack boundary; pending/unknown Send fence; lost ACK never duplicates work.
- [ ] T009 Prove two-Issue cross-task isolation, task-local concurrency/races, resource budget and fairness.

## Integrations and acceptance
- [ ] T010 Adapt ChatGPT browser worker and local Codex executors; preserve their existing authenticated sessions, signed reports and exact external command custody.
- [ ] T011 Implement dynamic peer-to-peer feedback, QA and independent reviewer cycles, unplanned security worker admission and blocked capability handling.
- [ ] T012 Add evidence gate + Main Agent final-review handoff; do not allow a worker to approve its own implementation or auto-finalize GitHub.
- [ ] T013 Retain v1 compatibility for existing #214/#224/#226/#232/#239 including ambiguous browser turn; add explicit v2 admission flag and non-destructive rollback.
- [ ] T014 Update appropriate AGENTS.md operating contract, README and CLI/MCP documentation only after the new policy/executor passes trusted review; remove immutable-graph requirement for *new v2* tasks, never retrospectively change v1.

## Verification / rollout
- [ ] T015 Run RED/GREEN targeted tests, full affected test suite, TypeScript build, command/recovery/concurrency stress, owner authorization negative cases.
- [ ] T016 Independent reviewer and security auditor inspect exact diffs, evidence, replay/identity protections; remediate in same Issue/PR without self-approval.
- [ ] T017 Run headed signed-in actual ChatGPT E2E with two Issues, direct Developer->QA->Security->Reviewer, new worker admission, Main Agent messages, real provider receipt, no duplicate send, restart, and legacy session preservation.
- [ ] T018 Obtain trusted owner approval of reviewed policy+Spec Kit+diff for cutover; roll out v2 to new tasks only, verify rollback and production observability.
- [ ] T019 Main Agent independently accepts, merges reviewed PR and closes Issue only after all gates, with exact evidence links and no unresolved legacy ownership conflicts.
