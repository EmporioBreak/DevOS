# Original Spec Kit tasks: durable ChatGPT worker chat availability queue

**Issue:** #232. **Phase:** DRAFT. Original Spec Kit tasks are not approved for implementation until owner signs the exact scope, plan and graph.

## Preflight and authorization
- [ ] T001 Validate pinned original Constitution, `spec.md`, `plan.md`, `tasks.md` and exact SHA/Issue/PR.
- [ ] T002 Get independently verified owner scope, plan, immutable graph, stage and skills approval; prepare signed assignments before starting Runner.
- [ ] T003 Read-only baseline of #214/#224/#226 and Production Camoufox profile, ensure no duplicate launch, no #226 replay.

## RED tests
- [ ] T004 Busy target (active Stop, disabled/covered send, unstable control) causes durable wait, zero filled prompts/clicks/POSTs; stable readiness releases one queued send.
- [ ] T005 No global busy signal remains explicitly unknown, and never silently claims overall account idle.
- [ ] T006 Concurrent same-turn workers/crash/restart/expired lease preserve single send; identity/Project mismatch blocks.
- [ ] T007 Click timeout before/after network interception, lost POST response or unknown receipt preserves `submission_ambiguous` with no replay. Signed exact report may complete without duplicate sending.
- [ ] T008 Project background wait survives Main Agent finishing user reply; finite timeout/backoff/cancel, no OS global daemon.

## Implementation
- [ ] T009 Build exact saved-chat read-only readiness probe and stable gate. No check based solely on button visibility.
- [ ] T010 Add private durable exact task+worker+turn+conversation/prompt send lease, atomic journal and idempotent reconciliation.
- [ ] T011 Integrate project-owned bounded queue and background wait (actual Runner process), no status/graph/auth bypass.
- [ ] T012 Split pre-attempt, armed, confirmed POST and ambiguous state; preserve existing browser session and turn and no duplicate post-submit replay.

## Verification / independent review
- [ ] T013 GREEN: full relevant unit/chaos/recovery tests; `npm run build`; one checkout and no changed #214/#224/#226 snapshots.
- [ ] T014 Real headed browser E2E with *permitted* separate busy/idle ChatGPT test conversations; prove exact one outgoing worker message and saved session, never infer unverified account-wide busy signal.
- [ ] T015 Signed independent code/security QA of exact PR, races and real E2E; defects returned to same original developer and PR.
- [ ] T016 Main Agent exact diff, tests and original acceptance review, then only approved merge/deploy. Retain any ambiguous #226 turn unchanged until separately verified.
