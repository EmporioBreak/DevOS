# Tasks: DevOS 2 QA — Normalize Test Label

**Feature Issue**: [#214](https://github.com/EmporioBreak/DevOS/issues/214)
**Input**: [spec.md](spec.md), [plan.md](plan.md)
**Status**: QA implementation underway; independent review and owner handoff pending

## Preflight — independent Main Agent controls

- [ ] **T001** Verify project Constitution is actually ratified (not placeholder), original upstream Spec Kit pins, and independently trusted owner approval for exact scope/spec/plan and fully frozen 4-worker graph plus linked PR.
- [ ] **T002** Seal signed strict Runner graph and required pinned per-worker skill manifests for this Issue and exactly one draft PR, with real owner authorization; do not fake `userMessageRef` or privileged checker output.

## User Story 1 — QA label normalization (P1)

- [x] **T003 [US1]** In `tests/devos2-live-feature.test.ts`, add enabled Node tests for four Issue acceptance samples, empty string, NBSP/Unicode whitespace and preservation of Unicode punctuation/combining marks. Run the targeted test and record actual **RED** on the missing implementation.
- [x] **T004 [US1]** Add minimal pure implementation `normalizeQaLabel` in `tests/fixtures/devos2-live-feature/normalize-qa-label.ts`. Do not import app production modules or add dependencies.
- [x] **T005 [US1]** Run the same targeted test **GREEN**, diff checks and any relevant scoped regressions; record real command outputs, source SHA, and affected files on the single draft PR.

## Independent review and owner handoff

- [ ] **T006** Predeclared independent QA reviewer inspects actual linked draft PR, the original spec/plan/tasks and real tests; submits signed MCP `approved` or actionable `changes_requested`.
- [ ] **T007** On real `changes_requested`, the same developer chat revises the **same PR**, then independent re-review; never plant intentional defects simply to trigger this stage.
- [ ] **T008** Runner returns verified `DEVOS_OWNER_HANDOFF` with `FINAL_REVIEW_REQUIRED`; Main Agent reviews the exact PR/head and decides. Never auto-merge or change Production runtime.

## Scope and ordering

T001 and T002 block T003–T008. T003 must precede T004 (TDD), then T005–T008. Each task remains an **original Spec Kit microtask**, not an extra GitHub Issue or dynamic worker. No tasks above have been performed merely because this draft tasks.md exists.
