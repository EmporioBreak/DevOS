# Original Spec Kit Bugfix scenario — Issue #131

This contract uses the **unchanged, SHA-pinned upstream** `github/spec-kit` bug extension commands `/speckit.bug.assess → /speckit.bug.fix → /speckit.bug.test`. Their canonical artifacts are `.specify/bugs/<slug>/assessment.md`, `fix.md`, `test.md`; it does not generate a new feature spec/plan/tasks for every defect.

`assessBugfixReadiness` requires an original Bugfix contract, exact Issue/PR and Git revision, independent owner scope approval, actual stage events checked by a trusted verifier, reproduction before changing code, a root-cause statement, changes only to pre-approved files, and host-confirmed execution of **both original reproducer and regression tests**. Any missing, failed or skipped check prevents `final_review_required`. The verdict `verified` requires every mandatory check to pass. Scope expansion must go back to Main Agent; a model-supplied reviewerRef or a successful-looking summary is not proof.

The original upstream extension commands are located by `src/spec-kit-scenarios.ts` in the pinned `~/.devos-staging/upstream/spec-kit`, compared byte-for-byte with the existing Git-backed upstream lock and read-only. Canonical stage files are independently checked against their actual Git commits and current checkout, with worktree path containment.

**One synthetic live-code fixture** creates a real temporary Git repository, reproduces a `TypeError` on missing token in `app.mjs`, applies a minimal null-safe fix, executes both original reproducer and a regression test through Node, and commits the original assessment/fix/test files. Additional tests exercise out-of-order stages, forged approvals, unverified tests, tampering and scope creep. These are genuine *fixture code executions* with synthetic trusted attestations, **not** a production ChatGPT worker or live independent reviewer.

Result `final_review_required` means return the **same Issue/PR and worker sessions** to Main Agent for final acceptance. It does **not** mean approval or merge. Actual browser-first worker, original extension invocation, code review and owner handoff remain part of Runner integration #144 and live Staging E2E #150/#151; there is no independent second execution engine.

```sh
npm run build
npx tsx --test tests/spec-kit-bugfix.test.ts
```
