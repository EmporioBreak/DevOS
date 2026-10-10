# Implementation plan — Issue #236 Task-specific teams

**Status:** DRAFT; not authorized for Runner until genuine owner-approved exact scope/Spec Kit/graph/roster receipts are verified  
**Canonical source:** [spec.md](spec.md), this original `plan.md`, [tasks.md](tasks.md); DevOS Constitution v0.1.0

## Design

Main Agent owns risk/acceptance identification and task-specific team design. Runner is a deterministic executor of the already frozen graph. Add a **mechanical coverage-validation preflight** at Main Agent's existing approval boundary, with an explicit typed `qualityCoverage`/equivalent in `ProjectIssuePlan` and a pure validator. Do **not** pretend this static validator can understand implicit product risks; benchmark live agent decisions independently.

### Data contract

Bind:
- exact accepted criterion IDs or indexes to the existing `intent.acceptance` array and `intakeDigest(intent)`;
- reviewable affected surfaces/risk ledger, justification for required or inapplicable checks, and trustworthy owner-review visibility;
- one or more check IDs per criterion, containing actual scenario, pass/fail oracle, environment and required **concrete** capabilities, evidence class and accountable execution/verification worker IDs;
- for each worker assignment, match exact ID/executor to frozen `Workflow`, source-pinned role/skills and capability receipt, not a free-text assertion;
- for each QA failure, existing workflow `on.changes_requested` path must permit rework via original developer and re-run affected gates;
- quality coverage digest included within graph+scope trusted approval binding and GitHub Issue publication (without privacy-sensitive data).

Avoid naming conventions as a proxy for worker ability except existing independent reviewer compatibility checks. Preserve clean comparison & error diagnostics. Use versioned exact schema, fail closed for new planning, avoid retroactively invalidating already approved/running Issue graphs. Reject duplicate/empty checks, orphan worker refs, missing acceptance criterion coverage, mismatched environment/tool classes, self-approval and change to signed graph.

### Implementation surfaces (worker may confirm minimum exact files)

- `src/main-agent-project-plan.ts`: approval/publication gate and digest binding.
- New focused `src/main-agent-quality-coverage.ts` or equivalent: schema and pure validation.
- `src/runner-skill-graph.ts` only if needed to bind stage/capability evidence without weakening strict graph signing; do not alter Runner routing.
- `tests/main-agent-project-plan.test.ts` existing fixture adjustments; focused new `tests/main-agent-quality-coverage.test.ts` + adversarial cases; other affected tests only when necessary.
- Documentation `docs/main-agent-intake.md` / `AGENTS.md` only if implementation creates a factual new operator contract.

### Threat model

Malformed/untrusted plan and user acceptance indices; forged host capability label; deceptive self-rated LLM completeness; stale owner digest after coverage edits; bypass via optional field, missing reviewer/qa route or unreachable worker; cross-Issue worker references; synthetic UI masquerading as visual observation. The static schema enforces only explicit approved coverage; live Main Agent prompts test recognition of unstated scenarios.

## Independent tests and verification matrix

| Case | Required result | Evidence |
| --- | --- | --- |
| Minimal bounded bug | pass 2 capable workers if complete; reject redundant role with no assigned purpose | pure validator fixture |
| Auth boundary | reject omitted deny/session isolation | curated benchmark and coverage fixture |
| Visual UI request | reject shell/headless as visual capability | fake/tool-real inventory negative |
| Durable send | reject missing concurrent/recovery/ambiguous-send scenario | curated benchmark + independent QA |
| Schema migration | reject absent integrity+rollback | benchmark + negative schema |
| Signed owner graph | any changed coverage / worker / criterion invalidates verified digest | trusted verifier test |
| Review changes | preserved exact developer/PR loop and impacted gate rerun path | graph reachability/integration fixture |
| Live behavioral agent | 5 task prompts without role hints, independent scoring & exact captured proposed graph | real model/ChatGPT host, no mock |
| End-to-end runner | safe test Issue/PR, signed worker reports, real independent review and Main Agent handoff | actual DevOS runtime and GitHub evidence |

Each test must initially demonstrate a meaningful RED against current implementation or deliberately rejected invalid contract and GREEN after code; report exact test names/count and failures. Run build + scoped tests + broad regression without disrupting Production connector. Full live E2E is a release gate: if blocked by shared Camoufox, report blocking dependency instead of inferring PASS.

## Worker capability and execution plan — exact proposed team, to be owner-approved

1. `team_composition_developer_local` (`codex`) implements pure validation and TDD plus integration in the sole Production checkout on this normal branch. Uses native signed original Spec Kit implementation + pinned TDD.
2. `team_composition_security_qa_local` (`codex`) independently attacks self-approved/missing criteria/false capability/stale consent/tampered graphs, reports defects to **same** developer/PR; doesn't self-approve code.
3. `team_composition_behavior_qa` (`chatgpt_browser`) drives actual model/ChatGPT behavior benchmark without hints to roles, verifies objective acceptance matrix; no duplicate/Camoufox overlap with existing #226.
4. `team_composition_e2e` (`chatgpt_browser`) independently verifies real signed Issue→Runner→GitHub worker/review→Main Agent handoff using safe test-only records; no fake agent or headless-only claim. If host surfaces to exercise Main Agent are not exposed, preserve blocker.
5. `team_composition_reviewer` (`chatgpt_browser`) reviews actual merged? **unmerged** PR head, source diff and evidence and submits signed approval or changes_requested. Main Agent alone does final accept/merge/Issue closure.

Transitions: developer `done`→security QA `done`→behavior QA `done`→E2E `done`→reviewer `approved`→Main Agent; any QA/reviewer `changes_requested`→same developer, rerun all downstream checks; `failed` terminals. Do not appoint any extra workers after start. Code cannot be merged before all original acceptance gates prove completed.

## Alternatives / decisions

- **Rejected:** force everyone to use Developer+QA+Security+Reviewer, because it creates cost without new evidence for safe changes.
- **Rejected:** let Runner examine task category and add/route specialized workers, violating signed graph and Main Agent authority.
- **Rejected:** trust only LLM-authored `risksCovered:true`, which is self-attestation and fails adversarial test.
- **Chosen:** explicit owner-reviewed coverage contract with deterministic fail-closed validation **plus independent agent-behavior and live system E2E**.

## Safety and staging

No second connector/Cloudflare, no new Mac worktrees or duplicate profiles; preserve running #224 and ambiguous #226, signed worker state in #232, and last merged root changes. Original iPhone native test remains owner-only. If exact owner approval or conflict-free real browser surface isn't available, stop before dispatch, leave Issue/PR draft and report the blocker; don't silently switch to dummy E2E.
