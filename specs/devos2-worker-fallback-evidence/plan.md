# Plan: correct browser-first worker fallback at the Runner boundary

**Issue:** #228
**State:** DRAFT — pinned original speckit.plan not yet attested

## Current architecture and defects
- src/orchestrator.ts appends identical MCP-only skill-access text to both executors; CodexExecutor already calls prepareCodexSkills before native Codex starts.
- Current needs_local_worker routing follows the worker.on mapping after status parsing, without machine-checkable evidence why authorized Desktop Commander could not do the work.
- Issue #226 demonstrated both defects: a browser worker with Mac access escalated on risk; local Codex obeyed browser-only auth instruction and terminated failed.

## Intended design
- Add executor-aware strict prompt formatting, with separate browser MCP and local signed skill methods.
- Define verifiable host-only capability blocker representation in a signed per-turn worker report and validate against trusted host-side observed tool/capability facts (not arbitrary natural-language claims).
- Gate transitions before mutating completedRuns/next worker when blocker is unsupported; persist scope-bound denial and preserve exact original browser conversation.
- Keep transport faults distinct from real needs_local_worker; no automatic ambiguous send replay and no unauthorized fresh chats.
- Make the browser-only skill instruction impossible for local Codex via tests, including complete prompt assembly, not merely helper text.

## Validation
- TDD RED for wrong local prompt and unexplained status routing; GREEN for admissible host-only failure and untrusted evidence rejection.
- Regression tests for signed report and task/worker/turn match, stale state, repeated checks, reviewer fallback and no duplicate sends.
- Build, focused tests and relevant full suite, independent reviewer and exact owner handoff.

## Safety boundary
No change to #226 runtime or #224 wake-up; no second connector, profile, worktree or unauthorized Codex worker approval. The only permitted implementation is scoped to #228 and its one linked PR.
