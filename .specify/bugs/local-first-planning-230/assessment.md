# Original Spec Kit Bugfix — Assess (#230)

## Reproduced discrepancy
Merged PR #229 authorized Main Agent to choose each worker's executor by concrete task capability, including preplanned Codex-first and normal `done → Codex` stages. However `src/main-agent-project-plan.ts::taskGraph` still rejected Codex-first (`Browser-first graph must start with a ChatGPT browser worker`) and required all Codex nodes to be mere `needs_local_worker` fallbacks. A real attempt to assemble a post-merge independent Codex-review-only graph for #228 failed before exact owner approval could be requested.

## Desired outcome and boundaries
Allow exact predeclared owner-signed local Codex stages at the start or after ordinary `done`, never invented by Runner. Reject unreachable, mutated, unsigned workers and retain independent reviewer, signed skills, genuine fallback evidence, project ownership, browser task sessions. No changes to #214/#224/#226, Camoufox processes, profile, connector or Production authorization.
