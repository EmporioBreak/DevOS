# Implementation Plan: DevOS 2 QA — Normalize Test Label

**Branch**: `devos2/qa214-feature-contract` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)
**Status**: DRAFT — proposed original Spec Kit plan, stage NOT attested and owner consent NOT verified
**Issue**: [#214](https://github.com/EmporioBreak/DevOS/issues/214)

## Summary

Create a pure TypeScript fixture normalizer for QA-only E2E validation. It will operate on Unicode whitespace using JavaScript string semantics. The implementation is deliberately limited to a new fixture module and one enabled test. The main purpose is to demonstrate the **real browser-developer → PR → independent reviewer → owner handoff** process, not to add application functionality.

## Technical Context

**Language/Version**: TypeScript on the current pinned repo Node.js runtime.
**Primary Dependencies**: None beyond the existing TypeScript and `tsx` test runner.
**Storage**: N/A (pure function).
**Testing**: Node.js test runner via `./node_modules/.bin/tsx --test tests/devos2-live-feature.test.ts`.
**Target Platform**: Repo QA fixtures only; no Production import.
**Project Type**: Pure internal QA test module.
**Performance Goals**: Deterministic linear scan or built-in regex operation for ordinary labels.
**Constraints**: No secrets, external network, browser manipulation, MCP restart or modifications to `src/`.
**Scale/Scope**: Exactly one fixture module and one test file (plus this task's original Spec Kit artifacts).

## Constitution Check — Document committed; protected task approval pending

The original project Constitution v0.1.0 has been committed through Issue #218 / PR #219 and is no longer the upstream placeholder (SHA-256 `43ac4954ceeb5deca93c77cff8c88593ebdf2f278f10432c8f3976a2d5e9574f`). This **does not itself prove** a provider-independent protected owner approval of the exact QA contract or original `speckit.plan` stage. Before strict Runner, verify the committed bytes and obtain a genuine human-password-backed owner task receipt bound to the exact Issue/PR/Constitution and all scope/plan/graph/roster hashes; no self-attested stage results.

## Project Structure

```text
.specify/specs/devos2-live-feature/
├── spec.md   # this canonical draft specification
├── plan.md   # this draft plan
└── tasks.md  # ordered, currently unstarted canonical tasks

tests/fixtures/devos2-live-feature/
└── normalize-qa-label.ts       # future browser/authorized worker implementation

tests/devos2-live-feature.test.ts # future enabled worker test
```

## Execution Plan (pending authorization)

1. Independently verify original pinned upstream Spec Kit Constitution, author-approved feature scope/spec/plan and exact linked PR/graph/worker role and skill roster. Strict source integrity cannot be satisfied by model-authored test metadata.
2. In the isolated QA branch, write the enabled tests **first** and capture actual RED test failure (missing implementation); then implement the minimal pure function; repeat the same tests GREEN.
3. Preserve this one Issue and one draft PR; real DevOS browser developer attempts first. Codex may run only on a concrete `needs_local_worker` routed through the frozen graph.
4. Independent browser reviewer checks actual diff and test logs. When a real defect is found, return `changes_requested` to the same browser developer and PR; do not fabricate a failure for telemetry.
5. DevOS returns authenticated `DEVOS_OWNER_HANDOFF`/`FINAL_REVIEW_REQUIRED`. Main Agent independently checks Issue, PR, review, tests and original artifacts; no automatic merge or production deployment.

## Safety / Original Spec Kit Boundary

These are **proposed** contents in canonical files, not simulated original Spec Kit stages or signed evidence. `spec.md → plan.md → tasks.md` are not enough to satisfy stage verification without trusted events. The original Upstream `github/spec-kit` and `obra/superpowers` resources remain pinned and unmodified. This QA Feature must not be counted as Bugfix or standalone Assess E2E.
