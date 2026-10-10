# Tasks: task-scoped windows in shared Camoufox

**Issue:** #226
**Status:** DRAFT; original speckit tasks stage not yet attested

## Preflight
- [ ] T001 Validate original committed Spec Kit Constitution and canonical three artifacts.
- [ ] T002 Obtain password-backed exact Issue, PR, SHA/digest and four-worker graph approval; seal all skill manifests.

## Implementation (only approved browser developer; local fallback if independently reported needs_local_worker)
- [ ] T003 Add RED regression for two simultaneous Issues sharing one persistent profile but separate top-level windows.
- [ ] T004 Add RED tests for per-task tab ownership, cross-Issue session/grant isolation, scope-confined cleanup, and crash recovery.
- [ ] T005 Implement project/profile-owned Camoufox runtime and per-Issue window leasing. Preserve worker-specific tab continuity.
- [ ] T006 Fix start/close routing and compatibility with existing saved task states; no second launch or global kill.
- [ ] T007 Prove GREEN, TypeScript build, wider regression and real two-window E2E.

## Independent review
- [ ] T008 Same predeclared independent reviewer examines actual PR diff, original scope, evidence and tests.
- [ ] T009 Any actual defects return changes_requested to original developer in same Issue and PR.
- [ ] T010 Trusted FINAL_REVIEW_REQUIRED handoff to Main Agent, which alone approves or returns changes_requested.

## Exit criteria
Task A approved closes A's window only; task B remains. No fabricated worker report, no copied Camoufox profile or extra worktree.
