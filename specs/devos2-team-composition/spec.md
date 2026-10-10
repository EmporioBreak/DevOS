# Feature specification — Task-specific production-ready worker coverage

**Issue:** [#236](https://github.com/EmporioBreak/DevOS/issues/236)  
**Status:** DRAFT — owner approval of exact originals, risks and full signed graph required before implementation  
**Constitution:** DevOS v0.1.0, ratified 2026-10-10  
**Source:** original pinned GitHub Spec Kit (no new execution engine)

## Context / problem

DevOS Main Agent currently verifies that a proposed implementation graph has an independent reviewer, but does not require an acceptance-to-evidence-to-capable-worker map. The Main Agent may therefore approve a developer+reviewer-only workflow for a change needing UI interaction, access-control tests, reliability, migrations or release validation. Merely increasing the number of agents or checking names does not establish readiness. An LLM can omit risk from its own checklist; a mechanical validator alone cannot infer all unstated requirements.

## User stories and acceptance scenarios

**US1 — Small safe change.** Given a bounded low-risk numerical typo fix with a regression check and independent review, Main Agent proposes only the necessary workers and passes preflight. It does not invent security/load specialists without a concrete affected surface. Every applicable criterion is covered by a real assigned action.

**US2 — Authentication and session isolation.** Given a user login/session change, Main Agent records the security boundary and specifies authorized, unauthorized, cross-session tests and independent evidence. If these checks are missing, missing-capability, delegated to an unauthorized/identical worker when independence is required, or marked pass by assertions alone, approval preflight rejects.

**US3 — User-facing application.** Given an explicit requirement for visually observed browser/desktop or iOS Simulator use, a scripted Playwright/shell screenshot or HTTP-only check does not count as that visual Computer Use. The chosen worker must have actual screen observation and interaction capabilities, otherwise the plan is blocked.

**US4 — Message durability.** Given a multi-session queue, require concurrency, restart, ambiguous-submit/no-duplicate and actual worker UI proof; prohibit blanket green based on unit tests. Rework re-runs affected QA against same PR.

**US5 — Data migration.** Given a database schema change, require data integrity, compatibility and rollback/forward migration checks, with non-production safe fixtures. Unassigned rollback is a preflight failure.

**US6 — End-to-end handoff.** On a fully signed complex Issue, original Runner executes a chosen action-specific chain of implementation, independent specialist QA, genuine system E2E and code review, returning `changes_requested` to the same approved developer, PR and sessions, finally handing off to Main Agent. A fake terminal text report or offline-only fixture is not acceptable E2E proof.

## Functional requirements

**FR-01 — Risk-based planning inputs.** A task-scoped coverage plan must reference the *exact* original owner-reviewed acceptance criteria (stable IDs / indexes and digest), changed product surfaces, risk decisions and explicit applicability or justified non-applicability of candidate checks. The planner selects checks from the actual scope, not a fixed list; unsupported self-asserted `not_applicable` cannot override an explicit acceptance requirement.

**FR-02 — Complete coverage.** Each applicable acceptance criterion maps to at least one specific executable scenario with a pass/fail oracle, environment/tool capability, expected independently observable evidence, and exactly declared worker(s) responsible for execution and verification. Generic 'QA passed' and review-only coverage without executable evidence are invalid when a test is needed.

**FR-03 — Capability & independence.** Every assigned worker identity/executor appears in the exact predeclared parseable graph, is reachable in the relevant branch, and has trustworthy host/tool capabilities for the assigned action; developer self-verification is not substituted for independent QA where required. Tool inventories are checked against **real** supported capabilities, not model-authored role labels. Explicit `visual_desktop_test` and `ios_simulator_visual_test` must not be satisfied by only `scripted_ui_test`.

**FR-04 — Failure and rework.** For any failing check, there is a predeclared route that reaches original implementer on the same Issue/PR, then all affected QA/reviewer gates; graph is stable and no dynamic workers. Abort/blocked outcomes do not get converted to approval.

**FR-05 — Approval integrity.** Validate before trusted owner approval / Runner dispatch, bind coverage evidence digest to exact Scope/Spec Kit SHA, Issue/PR and worker graph/roster. Rejected on missing, duplicate, stale, contradictory, forged or altered coverage; original provider-backed owner approval remains mandatory. Preserve already sealed running graphs.

**FR-06 — Minimal team.** No minimum named role count beyond implementation's independently predeclared reviewer. Several checks may be assigned to one suitable worker when independence and capability permit; each extra specialist must have a distinct justified verification scenario.

**FR-07 — Honest evidence.** Test code, synthetic fixture, actual Mac tool call, and live browser/provider signed report are distinct classes. A real visual GUI observation and real ChatGPT account/global idle signal cannot be claimed without actual trustworthy support.

## Testable acceptance gates

1. RED/GREEN deterministic unit/contract tests covering US1–US5 and missing criterion, fake capabilities, stolen self-approval, stale signature, unreachable worker, worker replaced after approval, duplicate/empty coverage, missing rerun path and unnecessary team inflation.
2. Integration test `prepareApprovedProjectPlan` refuses missing/invalid coverage **before** any task execution and keeps authorized signed graph immutable; backward-compatibility safe for running #224/#226/#228/#232.
3. Independent QA tests exercise at least five input task prompts with no worker names supplied; compare Main Agent's produced coverage with independent objective acceptance/risk oracle, recording both false omissions and unnecessary roles.
4. An actual no-secrets test-only Issue/PR is run through real authorized Runner, signed workers, defect/rework if present, final handoff and Main Agent judgment; independent reviewer inspects GitHub diff and real evidence. Don't self-certify production-ready if unavailable.
5. Build/full related regression pass; source diff scoped, safe Mac/Production connector and shared Camoufox state unchanged. No duplicate chat sends or background hijacking.

## Non-goals

- No universal specialist role template, per-category browser vs Codex routing, new autonomous Runner planner, dynamic worker creation, unapproved human intent inferred from LLM text, second Staging connector, owner iPhone native check, automatic production deploy or credentials/profile copies.
- No rewriting active immutable graphs of #224/#226/#228/#232 or replay of #226 ambiguous browser turn.
- No claim that static type/coverage validation proves Main Agent reasoned about every *unstated* risk; actual behavior must be separately tested with a qualified reference.

## Dependencies and constraints

UI/browser E2E can run only if a genuine safe shared Camoufox ownership situation is verified; existing #226 runtime currently retains an ambiguous worker turn. Do not merge without live proof. Keep full predeclared QA graph in Issue #236, with no new roles once launched. Original Main Agent final acceptance, GitHub closeout and PR merge apply. If a host-only capability is absent, report the true blocker rather than weakening the test.
