# Original Spec Kit Assessment scenario — Issue #132

This module uses the pinned, **unmodified** original github/spec-kit v1.1.2 `assess` extension. Original order: `speckit.assess.intake → research → define → shape → decide`; canonical artifacts live under `.specify/assessments/<slug>/`, with `problem.md` (original `define`), `concept.md` (`shape`) and `decision.md` (`decide`). Original Intake/Research stages are optional for initial exploration, but a `go` decision requires adequate trustworthy research and a shaped concept.

`inspectSpecKitAssessment` is a **read-only verifier**. It checks original extension command hashes from the immutable upstream lock, the original canonical artifact bytes against their actual Git SHA, ordered trusted stage events, independently attested decisions and a six-dimension scorecard with explicit sources and confidence. Assumptions cannot silently count as verified research. Valid outcomes are `go_candidate`, `clarify`, or `kill`. Unknown risks/questions lead to clarification rather than false `go`.

Every returned result explicitly sets `mayCreateIssue: false`, `mayCreatePr: false`, and `mayRunRunner: false`. Even `go_candidate` is **only** a recommendation: it carries a recommended option and possible scope; Main Agent must obtain a separate owner decision and produce a new, independently approved feature contract in #142/#143 before creating implementation Issues/PRs or launching Runner. A good assessment can stop at `kill` without any code changes.

Fixtures use original `.specify/assessments/.../{intake,research,problem,concept,decision}.md` names committed in a real temporary Git repository, test optional stages, honest source ratings, unsupported `go`, `kill`, `needs-clarification`, and malicious/tampered stage evidence. The verifier is a **synthetic trusted host callback** in unit tests, not an actual ChatGPT permission proof.

No separate Assessment workflow engine, hidden background PR creation, source-code writing, or model-triggered worker dispatch is introduced. Full original command execution and human review remain Staging end-to-end tasks #150/#151; orchestration handoff is #144.

```sh
npm run build
npx tsx --test tests/spec-kit-assessment.test.ts
```
