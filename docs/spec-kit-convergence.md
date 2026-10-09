# Original Spec Kit Implement → Converge contract — Issue #129

The original pinned github/spec-kit `speckit-implement` and
`speckit-converge` skills are **not modified**. This module validates
their canonical task and convergence semantics. DevOS Runner is the
only executor of the predeclared single-Issue worker graph, not a
second Spec Kit Workflow Engine.

## Original tasks and implementation order

The single original `specs/<feature>/tasks.md` is the only tasks
source. The checklist syntax uses `- [ ] T001...` / `- [x] T001...`.
`parseCanonicalTasks` rejects absent, duplicated and out-of-order
T IDs. Dependency constraints inside the approved plan/tasks must
be enforced in the actual implementation worker before marking
T steps complete; this parser is not an AI engineer and does not
execute the steps.

Successful implementation is not inferred from a model message
or checkbox alone. `TrustedConvergeReport` includes the original
implement event reference and an independent reviewer event
reference. A separately trusted `verifyReport` callback must
authenticate both events against the current Issue/PR and
owner-approved scope digest. This module does **not** provide an
unsafe default trust callback.

## Convergence, safely append-only

`convergeSpecKitTasks` validates the original `speckit-converge`
source against #136 SHA pins, the exact approved feature's Git
identity, current original Spec Kit spec/plan bytes and the
expected SHA of `tasks.md`. Convergence cannot write a new scope:
each gap must reference an existing owner-approved acceptance
criterion. Any new feature outside that contract goes back
to Main Agent for a new decision.

If real incomplete work remains, the only modification is
appending a new `## Phase N: Convergence` section to
`tasks.md` with freshly allocated T IDs, stable gap markers
and checked-off-style tasks marked **incomplete**.
No `spec.md`, `plan.md`, old tasks, code or PR is rewritten.
A short exclusive file lock and content-hash check prevent
overlapping/stale Converge writes. Re-running with the same
gaps is idempotent.

If there are no gaps, `tasks.md` remains **byte-for-byte
unchanged**; the status is `needs_implementation` when
unchecked steps remain, or `final_review_required` only
when all existing T steps are checked and the independent
reviewer has verified the actual code/tests.

**Final review is not automatic approval.** The existing
Orchestrator continues its declared developer/reviewer/codex
fallback statuses (`done`, `changes_requested`,
`approved`, `needs_local_worker`, `failed`) and keeps
the Issue, PR and browser/Codex sessions stable.
Main Agent alone decides final owner acceptance.

## Verification

```sh
npm run build
npx tsx --test tests/spec-kit-convergence.test.ts
```

Six tests create real temporary Git commits containing the
original spec/plan/tasks files. They confirm no-gap unchanged
bytes, incomplete tasks refusal, independent trusted
implement/review proof, append-only numbered gaps, repeated
Converge idempotency, scope rejection, SHA drift refusal,
and unchanged original spec/plan.

**Integration limitation:** the function does not execute original
`speckit-implement` or `speckit-converge` on a live ChatGPT
worker itself; #144 must connect the saved original stage,
signed owner-consent and task-scoped worker graph to these
validators, and #150/#151 must perform a real implementation,
review, Converge and rework E2E test. Until then this is
contract/fixture evidence, not proof of a production migration.
