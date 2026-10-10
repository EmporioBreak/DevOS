# Original Spec Kit predevelopment stages — Issue #128

DevOS 2 uses the **unmodified original** github/spec-kit
v1.1.2 skills and canonical artifacts. The Main Agent owns
predevelopment; the DevOS Runner must not start until this process
and the separate owner-consent contract #142 are complete.

This change is a **stage-readiness contract and structural fixture**.
It does not secretly launch another Spec Kit Workflow Engine and
does not claim that a real ChatGPT worker authored the test fixture.
Actual stage invocation/orchestration is an integration task, not
an automatic side effect of reading a skill.

## Canonical stage sequence

`inspectSpecKitPredevelopment` validates the original
`speckit-*` source SHA-256 through #136 before each stage:

1. `speckit-constitution` — **project-level** ratification, reused
   across features, not rewritten on every issue;
2. `speckit-specify` — original feature `spec.md`;
3. `speckit-clarify` — optional, updates original `spec.md`
   when ambiguity remains;
4. `speckit-plan` — original architecture, research and
   `plan.md` plus Constitution checks;
5. `speckit-checklist` — optional quality gate **verified by
   independently declared reviewer**, not self-approved developer;
6. `speckit-tasks` — single original `tasks.md` containing
   dependency-ordered `T001..N` microsteps;
7. `speckit-analyze` — optional read-only consistency check
   after tasks; does not write artifacts.

The main agent chooses the optional gates according to agreed
complexity, ambiguity and risk; do not insert meaningless review
ceremony for a tiny bounded edit. These original skills do not
create a second Superpowers plan or new independent agents.

## Verification of a stage

Stage evidence must include exact `stage`, `actor`,
`commit` SHA, canonical `files`, `result` and
`sourceRef` identifying an external trusted event.

A model-generated status/ref is **not authorization**:
an injected trusted `verifyStage` callback must independently
check the exact observed event. Stage events must form a strict
prefix of the configured original stage sequence: no skipped
mandatory stage and no out-of-order proof. Each referenced file
must remain in the worktree and have bytes identical to the
recorded Git commit.

If the original project's Constitution still contains
`[PROJECT_NAME]` or `[PRINCIPLE_1_NAME]`, no subsequent stage
can be marked passed. A real owner-approved Constitution must
be ratified separately, once per project. The current original
Staging `.specify/memory/constitution.md` remains a template;
no owner approval of its contents is fabricated.

If Checklist/Analyze discovers a critical or major gap in
spec/plan/tasks, the result is a **return to the earliest
appropriate original stage**, not a silent PASS. Fix and
re-verify that artifact before continuing. Constitution
conflicts must be resolved in original Spec Kit artifacts,
not diluted in the Constitution without owner approval.

A fully passed stage sequence yields
`readyForIntakeApproval:true`, **not** permission for
implementation. #142 still requires trusted user scope/spec/plan
approval, and #143 then records exact Issue/graph references.
#144 will enforce those contracts before launching Runner.

## Tests and limits

```sh
npm run build
npx tsx --test tests/spec-kit-predevelopment.test.ts
```

Six focused tests create real temporary Git repositories with
committed `spec.md`, `plan.md`, `tasks.md`, checklist and a
synthetic ratified Constitution, plus copies of the **original
unchanged** stage skills. They exercise all seven stages,
optional skipped gates, reviewer checklist, quality-gap return,
invalid/out-of-order/tampered proofs, unratified Constitution,
and the separate #142 owner-approval boundary.

The synthetic verifier is for tests only. It does not prove
actual host ChatGPT approval or a live original Spec Kit skill
execution. Real stage-by-stage Agent Context/hook handling
and tool integration, plus complete new-app E2E, must still
be exercised in the Staging release pipeline #144/#150/#151.
