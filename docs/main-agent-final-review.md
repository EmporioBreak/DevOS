# Main Agent final acceptance evidence — Issue #147

DevOS **Main Agent**, not Runner, reviewer or original Spec Kit Converge,
owns the final product judgment. A worker report containing `approved`
means only that the **independent reviewer** reached its local result.
No worker, original skill or convergence function may authorize a
GitHub merge or Production deployment.

`inspectMainAgentFinalReview` accepts the *already pending* state
from the existing Runner and the approved original intake contract.
It obtains a trusted current GitHub PR head/linked Issue plus actual
tests and independent review evidence from an injected provider.

It checks:
- exact same repo, Issue and PR, open PR and well-formed Git head SHA;
- original owner-approved Spec Kit `spec.md` and `plan.md` byte-identical
  to their pinned actual Git commit;
- canonical `tasks.md` still has the original tasks in order, allowing
  only checked status changes and append-only Convergence phases;
- **all** implementation and Convergence `Txxx` tasks marked complete;
- independent reviewer status and an separately trusted review event;
- each original acceptance criterion covered by a **passing,
  independently verified** test on the current PR head;
- incomplete, missing, stale, unverified, out-of-scope or modified
  evidence returns actionable `changes_required`, never silent PASS.

This API is intentionally **read-only** and always sets
`ownerApproved:false`, `releaseOrMergeAuthorized:false` and
`humanProductReviewRequired:true`, even when the result is
`ready_for_main_agent_judgment`. Main Agent then inspects the real
product itself and independently decides
`approved | changes_requested` through the existing Owner Result
entrypoint. The adapter used in tests is a fake; a live trusted GitHub
test/reviewer backend and ChatGPT Main Agent judgment are **not**
supplied here or falsely inferred from self-reported model output.

A strict Runner regression test proves the lifecycle across separate
Orchestrator instances:

1. Developer completes implementation; reviewer approves its part;
   task remains `final_review_required` with exact Issue/PR.
2. Ordinary reconnect without Main Agent verdict does **not** run
   another worker or close the task.
3. Main Agent `changes_requested` reuses **the same developer and
   reviewer saved ChatGPT Project conversation URLs**, the existing
   PR and the immutable worker graph for another correction/review.
4. Another `final_review_required` awaits Main Agent again.
5. Only explicit `mainAgentDecision: "approved"` calls terminal
   finalization and releases stored task state; neither Converge nor
   reviewer substitutes for this decision.

The existing `FINAL_REVIEW_REQUIRED` protocol is unchanged and
the final merge/release gate remains separately managed (V06 #154).

## Verification

```sh
npm run build
npx tsx --test tests/main-agent-final-review.test.ts \
  tests/runner-skill-graph.test.ts tests/orchestrator.test.ts \
  tests/spec-kit-convergence.test.ts
```

Fixtures use actual temporary Git commits for approved Spec Kit
artifacts, then test a completed task list with an append-only
Convergence section. Negative tests reject PR/Issue mismatch,
stale/failing test head, incomplete criteria and tasks, modified
scope/plan or old T-step content. The independent review verifier
is simulated, so this is a testable gate, **not** a real GitHub
independent human review or iPhone/browser E2E.

No secrets, chat URLs or OAuth tokens should be included in public
GitHub acceptance reports. Live staging verification is tracked
under #150/#151, security checks #152, and release promotion #154.
