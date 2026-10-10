# Main Agent intake and predevelopment gate — Issue #142

This is the **DevOS Main Agent** intake contract. DevOS Runner remains
a narrow executor of a single predeclared Issue graph, not a project
planner. This module is a dependency for the Main Agent and Runner
integration (#143/#144). It does not start workers or authenticate chats.

## User request paths

`classifyIntake` does conservative initial routing and returns
`needsClarification` for text that is ambiguous or matches multiple
scenarios. The Main Agent may supply an explicit classification based
on verified project context; an LLM classifier alone is **not**
permission to implement:

- **feature**: new product/service, normally architectural;
- **change**: existing UI/product redesign, with a declared baseline;
- **bugfix**: scoped defect fix, original Spec Kit Bugfix artifacts;
- **assessment**: read-only evaluation, original Spec Kit Assess
  artifacts, no mandatory new PR/Issue/Runner.

A small change may be explicitly `bounded`. An architectural
change requires at least two compared alternatives with concrete
benefits/risks, chosen approach, owner goals, user scenarios,
non-goals and measurable acceptance criteria. Spec Kit uses the
original pinned `spec.md`, `plan.md`, `tasks.md`, not a second
Superpowers plan.

## Before implementation

`decideIntake` validates original `SpecKitArtifactContract` from
#127 and checks all pinned original artifacts byte-for-byte against
the **actual Git SHA** using `verifySpecKitArtifactRevision`.

Approval requirements:
- feature/change architectural: owner scope + spec + plan;
- bounded feature/change/bugfix: owner scope;
- assessment only: no implementation authorization (read-only).

Each approval must bind the **same exact SHA-256 digest** of the
current intake contract and the canonical artifact Git revision.
`userMessageRef` is only a **claim**: it cannot authorize anything
without a separate trusted `verifyApproval` callback resolving a
real user decision in the ChatGPT host/Main Agent context.
The current library deliberately ships **no default verifier**.
The project cannot invent, infer from silence, or synthesize approval.

A material change creates a new digest. Existing approvals cannot
silently cover the changed scope, baseline or spec/plan version.
A new verified owner decision can authorize the new version.
During rework of an already approved unchanged revision, the same
verified evidence is reusable — a browser worker does **not** prompt
the owner again on each implementation T-step.

A verified assessment returns `assessment_only`, not
`approved_for_issue`. A verified implementation returns
`approved_for_issue` to **Main Agent**, not a permit for Runner
to create its own agents or decide which GitHub Issue comes next.

## Task-specific worker team and acceptance coverage

Before signing the exact Issue graph, Main Agent must map **each applicable production-readiness acceptance check** to its scenario, required tools/environment, independent evidence, named predeclared worker, and failure/rework route. Select roles based on the concrete task's risk (for example, a real UI journey, auth/isolation, concurrency/recovery or deploy/rollback), **not** a fixed roster or an automatic developer+reviewer-only template. Record a task-specific reason when a check is not applicable. A small low-risk change may need just a developer and an independent reviewer, while a complex feature may justify distinct specialist verification.

Design the graph only after assigning this evidence coverage. Each chosen executor must actually support the intended action: headless/browser scripts do not prove a requested human-style visual GUI interaction. An independent reviewer remains mandatory for implementation, but its generic approval cannot replace missing specialized E2E/security/reliability evidence. Rework routes must return to declared existing workers on the same Issue/PR and re-verify impacted checks. Pin the complete coverage and graph in the owner-approved Issue before Runner starts. If any required check has no capable executor, block or revise the plan through fresh trusted owner consent; Runner must not invent another role.

## Current integration limit

This PR supplies deterministic routing, a strict contract and a
testable verification boundary, **not** actual ChatGPT user-message
attestation. #143 must use an authenticated owner decision and
publish exact Issue/commit references; #144 must consume its
readiness verdict before launch. Without that integration, the
correct answer for actual approval remains **blocked/needs review**.

No runtime MCP authorization, GitHub writes, worktree creation or
Runner dispatch happens inside this module. Owner intent must
still be clarified conversationally, not by a noisy form.

## Evidence

```sh
npm run build
npx tsx --test tests/main-agent-intake.test.ts
```

The six tests create **real temporary Git repositories** with
committed original Spec Kit artifacts and verify new-app approval,
redesign reapproval, bounded Bugfix, read-only assessment, ambiguous
classification and rejection of false consent or changed Git files.
The trusted approval callback used by tests is deliberately a fake
for a synthetic user message; tests are not evidence of actual
ChatGPT user authorization.
