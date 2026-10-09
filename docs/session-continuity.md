# DevOS 2 — browser/Codex continuity regression (Issue #146)

The original task-scoped Camoufox and Codex session lifecycle is reused, **not replaced**. The strict signed Runner graph introduced by #144 does not authorize a new conversation, new task, new worker role or resubmission simply because a session goes missing.

## Covered regression scenarios

- The same Issue and worker retain the exact saved **Project chat URL** through developer ↔ independent reviewer corrections. Turns get distinct attempt IDs; review remains on the same linked PR. The Main Agent still owns the `FINAL_REVIEW_REQUIRED` decision.
- A browser result may already have been submitted even when its terminal status is missing/malformed. The persisted identity and active turn are kept; ordinary resume refuses to resend that side-effectful prompt until a trusted terminal MCP report resolves it.
- A previously started browser worker without a saved conversation cannot be silently replaced with a fresh chat; Project URL scope and pre-submit/post-submit distinctions remain authoritative.
- The existing bounded local Codex recovery preserves sessions on valid logical JSONL completion and distinguishes pre-execution errors from post-execution ambiguity.
- Signed worker manifest and exact original stage are verified **again** before each resumed worker dispatch, rather than derived from an LLM description.

The new strict-mode tests live in `tests/runner-skill-graph.test.ts`. Existing browser recovery, Codex and task-scoped socket-lifecycle suites are rerun together.

## Genuine host-level Camoufox smoke

```sh
npx tsx tests/shared-browser-runtime.smoke.ts
```

Uses **new temporary, separate** owned/control Camoufox profiles. Asserts that the task runtime outlives a controller connection, subsequent controllers use the **same actual browser process**, owner metadata identifies that process, and shutdown kills only the owned process while leaving an unrelated independent control Camoufox running. No Production browser profile/cookies or running MCP are touched.

This host smoke has actually passed on Mac in the isolated Staging worktree, reporting `runtimeProcessSurvivedControllerExit:true`, `sameBrowserRootAcrossControllers:true`, `ownedCleanupFallback:true`, `controlSurvived:true`.

## Honest limits

These tests are genuine local process/browser tests and deterministic mock worker conversations, not a claim that ChatGPT's Web/iPhone UI has completed a **real** signed browser-workflow session. That requires the Staging plugin and live GitHub QA Issues (#150/#151). Production session state and ngrok are not restarted or modified.

```sh
npm run build
npx tsx --test tests/runner-skill-graph.test.ts \
  tests/browser-lifecycle-recovery.test.ts \
  tests/browser-recovery.test.ts \
  tests/codex-executor.test.ts \
  tests/shared-browser-runtime.test.ts \
  tests/orchestrator.test.ts
```
