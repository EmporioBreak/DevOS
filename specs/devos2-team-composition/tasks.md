# Implementation tasks — Issue #236 Team-specific worker coverage

**Status:** DRAFT — not approved, do not dispatch until exact owner receipt verified.  
**Spec Kit:** original canonical `spec.md` + `plan.md`; source pinned to PR commit.

## Phase 1: Validate capability and original intake schema

- [ ] T001 Inventory current `src/main-agent-project-plan.ts`, `src/workflow-loader.ts`, `src/runner-skill-graph.ts`, relevant security/skills manifest and existing tests. Record untouched active Runner Issue state. Preserve Constitution and approved graph behavior.
- [ ] T002 Define versioned coverage contract referencing exact original intake acceptance entries, risk/applicability decisions, environment/tool classes, independent evidence and declared worker identities. Show source-digest and threat-model boundaries.

## Phase 2: Test-first mechanical validator

- [ ] T003 Write RED tests: missing criterion/duplicate check/empty oracle/unreachable worker/cross-Issue refs/absent independent verification/unnecessary specialist/misleading `all risks covered` waiver, then run and record failure.
- [ ] T004 Write RED tests: user-required real visual interaction wrongly mapped to scripted/headless/shell control; security deny and race/recovery cases without independent scenario; schema migration lacking integrity and rollback.
- [ ] T005 Implement smallest pure validation for exact explicit coverage, typed tools/capability constraints, worker graph reachability and correct failure/rework loop to same original developer and re-verification path.
- [ ] T006 Make GREEN focused validator and deterministic integration tests, including valid tiny and complex team compositions (no fixed role count).

## Phase 3: Main Agent approval/publication boundary

- [ ] T007 Write RED consent tamper tests: different acceptance/coverage/worker/tool/evidence changes owner-approved digest; no missing/optional quality-contract bypass in new work; running historical workflow compatibility.
- [ ] T008 Wire coverage preflight into `prepareApprovedProjectPlan` before any Runner start and GitHub publishing; bind exact coverage to trusted plan approval and expose non-sensitive criterion→worker evidence in Issue.
- [ ] T009 GREEN + run affected `tests/main-agent-project-plan.test.ts`, strict signed Runner and spec-kit/intake approval test suites. Verify no modification of active task states, skills roster or Runner routes.

## Phase 4: Independent QA

- [ ] T010 Independent security QA runs invalid input/fake host capability/stale graph/unsigned owner proof and negative tests. If any fail, `changes_requested` to same developer/PR, rerun from T003/T007 as needed.
- [ ] T011 Independent ChatGPT behavioral QA supplies five representative tasks **without role suggestions** (tiny bug, auth, visual UI, durable queue, migration), captures real Main Agent planning outputs and scores against risk/acceptance oracle. Flag missing checks and excessive workers. Do not substitute a static prompt fixture for live agent response.
- [ ] T012 Independent real end-to-end QA validates a safe approved test Issue, genuine signed Runner worker turns, objective QA failure/rework if present, review and Main Agent handoff. If ChatGPT profile conflict #226 or host-only capability prevents it, return concrete blocked/needs_local_worker evidence and DO NOT claim end-to-end PASS.

## Phase 5: Review and acceptance

- [ ] T013 Independent code reviewer verifies diff limited to scope, RED→GREEN, broad build/regression, security/approval integrity and actual live behavioral/E2E reports; `changes_requested` returns to original developer preserving PR.
- [ ] T014 Main Agent inspects exact current PR head, all signed worker tests/reviews and primary acceptance ledger; only if truly satisfied approves, merges PR and closes Issue. Otherwise same-PR rework or documented blocker.

## Required evidence in PR / Issue

- Exact commit + link to RED failure and GREEN pass/test command/summary.
- Risk/criterion→check→worker mapping including non-applicable reason and actual tool capability.
- Positive+negative verifier/trusted-approval tests (no model-supplied receipt impersonation).
- Real ChatGPT host model behavioral results and genuine Runner signed MCP/PR proof, with explicit distinction from mocks.
- No restart/replay/duplicate OAuth/Camoufox/Issue #224/#226/#232 effects.
