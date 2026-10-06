# DevOS Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevOS resilient to browser-profile identity drift, connector/runtime crashes, stale PID ownership, duplicate task execution, state-write races, runaway orchestration, unbounded subprocess output, and workflow repository mismatch while keeping connector secrets in project `.env` and preserving existing browser/OAuth/main-agent invariants.

**Architecture:** Introduce focused process-identity, task-lock, connector-supervisor, and connector-env modules rather than growing `connector.ts` further. Keep existing public CLI semantics; add explicit bounded lifecycle state, fail-closed ownership checks, persisted orchestration budgets, and test seams for OAuth crash consistency. Browser launch changes suppress only the specific Playwright defaults that break persistent identity.

**Tech Stack:** Node.js >=22, TypeScript 5.9, Playwright 1.63, Node test runner via `tsx --test`, MCP SDK, Express.

**Spec:** `docs/superpowers/specs/2026-10-07-devos-reliability-hardening-design.md`

## Global Constraints

- Do not add GitHub Actions or any CI workflow.
- Do not add macOS Keychain integration.
- Connector secret precedence is process environment → project `.env` → explicit missing-credential error.
- Never persist or log connector secret values, bearer tokens, OAuth codes, request bodies, or raw MCP payloads.
- Preserve browser fail-closed same-task session semantics.
- Preserve the main-agent finalization ordering: persist approval → finalize task → clear state.
- Preserve existing OAuth security properties: AES-GCM, PKCE S256, resource binding, refresh rotation, replay-family revocation.
- Do not introduce a global daemon, LaunchAgent, login service, or unbounded restart/polling loop.
- Existing `run` and `restart` CLI semantics remain intact.
- Node.js support remains >=22.

## Review Focus

- PID reuse or stale ownership state must never cause DevOS to signal an unrelated live process; covered in Task 3.
- A crash during refresh-token rotation must not resurrect a consumed refresh token after restart; covered in Task 12.
- Resuming an old orchestration state must not reset the wall-clock budget or review-loop count; covered in Task 8.
- Bounded subprocess retention must not break `onOutput` streaming or early-completion detection; covered in Task 9.
- Browser launch hardening must not disable the existing fail-closed browser-session recovery rules; covered in Task 1.

---

### Task 1: Preserve Chrome identity under Playwright

**Files:**
- Modify: `src/browser-config.ts`
- Modify: `src/chatgpt-browser-executor.ts`
- Modify: `tests/browser-config.test.ts`
- Modify: `tests/chatgpt-browser-executor.test.ts`
- Verify existing: `tests/browser-lifecycle-recovery.test.ts`
- Verify existing: `tests/browser-recovery.test.ts`

**Interfaces:**
- Produces: `CHATGPT_PERSISTENT_PROFILE_IGNORED_DEFAULT_ARGS: readonly string[]`
- Consumes: Playwright `chromium.launchPersistentContext(..., { ignoreDefaultArgs })`

- [ ] **Step 1: Write the failing browser launch configuration tests**

Add assertions that the exported ignored-default-args set contains exactly the identity-breaking defaults from the spec:

`--disable-extensions`, `--disable-component-extensions-with-background-pages`, `--use-mock-keychain`, `--password-store=basic`, `--disable-sync`.

Add an executor-level assertion that persistent context launch receives this list.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npm test -- tests/browser-config.test.ts tests/chatgpt-browser-executor.test.ts`

Expected: FAIL because the ignored-default-args export/launch option does not exist.

- [ ] **Step 3: Implement the minimal launch hardening**

Export the constant from `src/browser-config.ts` and pass it as `ignoreDefaultArgs` in `launchPersistentContext`.

Do not replace all Playwright defaults and do not change fail-closed session logic.

- [ ] **Step 4: Run focused and browser recovery tests**

Run: `npm test -- tests/browser-config.test.ts tests/chatgpt-browser-executor.test.ts tests/browser-lifecycle-recovery.test.ts tests/browser-recovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser-config.ts src/chatgpt-browser-executor.ts tests/browser-config.test.ts tests/chatgpt-browser-executor.test.ts
git commit -m "fix: preserve persistent Chrome identity"
```

### Task 2: Load connector secrets from .env safely

**Files:**
- Create: `src/connector-env.ts`
- Create: `tests/connector-env.test.ts`
- Modify: `src/connector.ts`
- Modify: `.gitignore`
- Modify: `README.md` only for concise setup guidance if existing connector setup docs mention exported secrets

**Interfaces:**
- Produces: `loadConnectorSecrets(root: string, env?: NodeJS.ProcessEnv): Promise<{ ownerSecret: string; ngrokAuthtoken: string }>`
- Produces: `parseEnvFile(text: string): Record<string, string>`
- Consumes: project root and process environment

- [ ] **Step 1: Write failing parser and precedence tests**

Cover comments, blank lines, quoted values, simple unquoted values, process-env override, missing-file behavior, and explicit missing-secret errors.

Assert returned errors name the missing variable but never include secret contents.

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `npm test -- tests/connector-env.test.ts`

Expected: FAIL because `connector-env.ts` does not exist.

- [ ] **Step 3: Implement minimal .env parsing and secret resolution**

Read only `<root>/.env`. Do not evaluate shell syntax or variable interpolation.

Add `.env` to `.gitignore`.

Wire connector startup/background launch through the resolved secrets while retaining current bootstrap environment isolation.

- [ ] **Step 4: Run connector env and launcher security tests**

Run: `npm test -- tests/connector-env.test.ts tests/devos-launcher.test.ts tests/connector.test.ts`

Expected: PASS and synthetic secrets remain absent from output/log assertions.

- [ ] **Step 5: Commit**

```bash
git add .gitignore src/connector-env.ts src/connector.ts tests/connector-env.test.ts README.md
git commit -m "feat: load connector secrets from dotenv"
```

### Task 3: Prove process ownership before signaling

**Files:**
- Create: `src/process-identity.ts`
- Create: `tests/process-identity.test.ts`
- Modify: `src/connector.ts`
- Modify: `tests/connector-process-fixture.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Produces: `captureProcessIdentity(pid: number): Promise<ProcessIdentity | null>`
- Produces: `sameProcessIdentity(expected: ProcessIdentity, actual: ProcessIdentity): boolean`
- Produces: persisted identity fields: PID, start time, executable path, project root, ownership token, runtime marker
- Consumes later: Task 6 task-lock stale-owner validation

- [ ] **Step 1: Write failing identity tests**

Cover a live matching child process, same PID metadata mismatch, exited process, and malformed stored identity.

- [ ] **Step 2: Run identity tests to verify RED**

Run: `npm test -- tests/process-identity.test.ts`

Expected: FAIL because the identity module does not exist.

- [ ] **Step 3: Implement process identity capture**

On macOS, use bounded system process inspection without shell interpolation. Normalize executable and start-time values into a stable serializable structure.

- [ ] **Step 4: Write failing connector-stop ownership tests**

Add tests proving:
- matching identity may be terminated;
- mismatched identity for a live PID is never signaled;
- stale dead ownership state is removable;
- ambiguous live ownership reports an error instead of killing.

- [ ] **Step 5: Wire identity persistence and safe stop**

Replace PID-only authority in `background.json` and stop/status ownership paths.

- [ ] **Step 6: Run focused connector tests**

Run: `npm test -- tests/process-identity.test.ts tests/connector.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/process-identity.ts src/connector.ts tests/process-identity.test.ts tests/connector-process-fixture.ts tests/connector.test.ts
git commit -m "fix: verify connector process ownership"
```

### Task 4: Add bounded connector supervision and lifecycle state

**Files:**
- Create: `src/connector-supervisor.ts`
- Create: `tests/connector-supervisor.test.ts`
- Modify: `src/connector-runner.ts`
- Modify: `src/connector-runtime.ts`
- Modify: `src/connector.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Produces: `ConnectorLifecycleStatus = "starting" | "healthy" | "recovering" | "degraded" | "terminal_failed" | "stopped"`
- Produces: `runConnectorSupervisor(options): Promise<void>`
- Produces persisted diagnostics: last failure component/time, exit code/signal, restart attempt/max
- Consumes: Task 3 process identity

- [ ] **Step 1: Write failing supervisor state-machine tests**

Use injected runtime launcher/sleep/health callbacks to prove restart backoff sequence `2s, 5s, 10s, 20s, 30s`, max 5 attempts, transition to `recovering`, and terminal `terminal_failed` after budget exhaustion.

Also cover healthy stabilization resetting consecutive-failure budget.

- [ ] **Step 2: Run supervisor tests to verify RED**

Run: `npm test -- tests/connector-supervisor.test.ts`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement the bounded supervisor**

Keep the supervisor project-scoped and finite. The supervisor owns runtime launch/relaunch and persists lifecycle diagnostics atomically.

- [ ] **Step 4: Wire background runner through the supervisor**

`connector-runner.ts` becomes the stable background owner. `connector-runtime.ts` remains one private runtime attempt.

Ensure shutdown signals stop recovery and terminate only proven-owned runtime groups.

- [ ] **Step 5: Add status/diagnostic assertions**

Update connector tests so `status` distinguishes supervisor ownership, gateway health, runtime state, ngrok registration, lifecycle state, and current restart attempt.

- [ ] **Step 6: Run connector supervision suite**

Run: `npm test -- tests/connector-supervisor.test.ts tests/connector.test.ts tests/cli-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/connector-supervisor.ts src/connector-runner.ts src/connector-runtime.ts src/connector.ts tests/connector-supervisor.test.ts tests/connector.test.ts
git commit -m "feat: supervise connector runtime with bounded recovery"
```

### Task 5: Bound connector diagnostics and keep secrets out

**Files:**
- Modify: `src/connector-supervisor.ts`
- Modify: `src/connector.ts`
- Modify: `src/debug-log.ts` only if a shared bounded writer is appropriate
- Modify: `tests/connector-supervisor.test.ts`
- Modify: `tests/debug-log.test.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Produces: bounded local connector diagnostics under `.devos/logs/` or existing connector state area
- Consumes: Task 4 lifecycle events

- [ ] **Step 1: Write failing diagnostics tests**

Generate enough lifecycle/failure events to exceed the chosen bound and assert old diagnostics are truncated/rotated while recent events remain.

Inject synthetic secret/token/request-body values and assert none appear in stored diagnostics.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `npm test -- tests/connector-supervisor.test.ts tests/debug-log.test.ts tests/connector.test.ts`

Expected: FAIL on missing bounded connector diagnostics.

- [ ] **Step 3: Implement bounded diagnostic persistence**

Use a small append/rotation strategy with explicit field allow-listing rather than raw object serialization.

- [ ] **Step 4: Re-run focused tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connector-supervisor.ts src/connector.ts src/debug-log.ts tests/connector-supervisor.test.ts tests/debug-log.test.ts tests/connector.test.ts
git commit -m "feat: add bounded connector diagnostics"
```

### Task 6: Add per-task execution locks

**Files:**
- Create: `src/task-lock.ts`
- Create: `tests/task-lock.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Produces: `acquireTaskLock(projectRoot: string, task: TaskRef): Promise<{ release(): Promise<void>; runId: string }>`
- Consumes: Task 3 process identity
- Lock path: `.devos/locks/<encoded-repo>-issue-<issue>.lock`

- [ ] **Step 1: Write failing task-lock tests**

Cover exclusive creation, second live owner rejection, stale dead owner cleanup, live identity mismatch treated as stale only when the stored identity proves it is not the current process, and release ownership-token validation.

- [ ] **Step 2: Run lock tests to verify RED**

Run: `npm test -- tests/task-lock.test.ts`

Expected: FAIL because `task-lock.ts` does not exist.

- [ ] **Step 3: Implement the lock**

Use exclusive file creation and persist repo, issue, PID, process identity, random run ID, and startedAt.

- [ ] **Step 4: Wire the lock around workflow execution**

Acquire before state load/reset/mutation and release in `finally` after browser shutdown/finalization paths complete.

- [ ] **Step 5: Run lock and CLI tests**

Run: `npm test -- tests/task-lock.test.ts tests/cli.test.ts tests/cli-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/task-lock.ts src/cli.ts tests/task-lock.test.ts tests/cli.test.ts
git commit -m "fix: serialize task execution"
```

### Task 7: Make state writes collision-safe and reject cross-repo workflows

**Files:**
- Modify: `src/json-state-store.ts`
- Modify: `tests/json-state-store.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Produces: unique temp path per state save
- Produces: `assertWorkflowMatchesProject(workflow: Workflow, config: ProjectConfig): void`

- [ ] **Step 1: Write failing state-temp collision test**

Force overlapping saves and assert each uses an independent temp path and the final destination remains valid JSON.

- [ ] **Step 2: Write failing repository mismatch test**

Exercise explicit workflow-file mode with `workflow.task.repo !== config.repo` and assert failure occurs before `runWorkflow`/executor mutation.

- [ ] **Step 3: Run focused tests to verify RED**

Run: `npm test -- tests/json-state-store.test.ts tests/cli.test.ts`

Expected: FAIL on both new behaviors.

- [ ] **Step 4: Implement unique atomic temp files and repo guard**

Temp path format: `<state>.tmp.<pid>.<random>`, same directory, then atomic rename.

Call repository assertion for every workflow execution path.

- [ ] **Step 5: Re-run focused tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/json-state-store.ts src/cli.ts tests/json-state-store.test.ts tests/cli.test.ts
git commit -m "fix: harden state writes and workflow scope"
```

### Task 8: Add persisted orchestration safety budgets

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/json-state-store.ts`
- Modify: `tests/orchestrator.test.ts`
- Modify: `tests/json-state-store.test.ts`

**Interfaces:**
- Extend `RunState`: `startedAt?: string`, `reviewLoops?: number`
- Extend `OrchestratorOptions`: optional `maxWorkerRuns`, `maxReviewLoops`, `maxWallClockDurationMs`, `now?: () => number`
- Defaults: 30 worker runs, 8 review loops, 6 hours

- [ ] **Step 1: Write failing max-worker-run test**

Create a cyclic workflow and assert the next worker is not launched after 30 completed runs.

- [ ] **Step 2: Write failing max-review-loop test**

Route repeated `changes_requested` transitions and assert explicit failure after 8 review loops.

- [ ] **Step 3: Write failing persisted wall-clock test**

Seed state with an old `startedAt`, resume with injected `now`, and assert the six-hour limit is enforced without resetting the origin.

- [ ] **Step 4: Run orchestrator tests to verify RED**

Run: `npm test -- tests/orchestrator.test.ts tests/json-state-store.test.ts`

Expected: FAIL because the budget state/options do not exist.

- [ ] **Step 5: Implement budget accounting**

Persist `startedAt` on first run, retain it through owner-review cycles, increment review-loop count only for `changes_requested` rework transitions, and check budgets before dispatching another worker.

Errors name the exceeded budget and emit task `failed` where the current lifecycle permits.

- [ ] **Step 6: Re-run focused tests**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator.ts src/json-state-store.ts tests/orchestrator.test.ts tests/json-state-store.test.ts
git commit -m "feat: bound orchestration loops"
```

### Task 9: Bound retained subprocess output without breaking streaming

**Files:**
- Modify: `src/command-runner.ts`
- Modify: `tests/command-runner.test.ts`

**Interfaces:**
- Extend `CommandResult`: `stdoutTruncated?: boolean`, `stderrTruncated?: boolean`
- Retained output: first 64 KiB + last 1 MiB for each stream
- `onOutput` and `completeWhenOutput` continue to receive the live cumulative logical stdout required by existing callers; if implementation cannot safely keep cumulative text unbounded, introduce an internal streaming matcher that preserves current observable behavior without retaining unlimited output.

- [ ] **Step 1: Write failing large-output retention test**

Produce >2 MiB stdout/stderr and assert retained results contain the head and tail, omit the middle, and set truncation flags.

- [ ] **Step 2: Write failing streaming-regression test**

Assert `onOutput` still observes text across the truncation boundary and `completeWhenOutput` still terminates the owned process group on its marker.

- [ ] **Step 3: Run runner tests to verify RED**

Run: `npm test -- tests/command-runner.test.ts`

Expected: FAIL on missing truncation behavior/metadata.

- [ ] **Step 4: Implement bounded retention**

Use a small head/tail buffer helper inside `command-runner.ts` unless extraction improves clarity.

Ensure debug logs only receive bounded retained output.

- [ ] **Step 5: Re-run runner tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/command-runner.ts tests/command-runner.test.ts
git commit -m "fix: bound subprocess output retention"
```

### Task 10: Make launcher installs reproducible

**Files:**
- Modify: `devos`
- Modify: `tests/devos-launcher.test.ts`

**Interfaces:**
- Self-host/runtime install command becomes `npm ci`
- Existing connector bootstrap remains `npm ci --ignore-scripts`

- [ ] **Step 1: Change launcher tests first**

Replace expectations for `install --no-package-lock` with `ci` in self-host refresh and runtime refresh tests.

Add an assertion that no launcher path invokes `npm install --no-package-lock`.

- [ ] **Step 2: Run launcher tests to verify RED**

Run: `npm test -- tests/devos-launcher.test.ts`

Expected: FAIL because the launcher still calls `npm install --no-package-lock`.

- [ ] **Step 3: Replace install paths with `npm ci`**

Keep current environment isolation behavior unchanged.

- [ ] **Step 4: Re-run launcher tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add devos tests/devos-launcher.test.ts
git commit -m "fix: use lockfile-reproducible installs"
```

### Task 11: Strengthen connector status around actual component health

**Files:**
- Modify: `src/connector.ts`
- Modify: `src/connector-supervisor.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Consumes: Task 4 lifecycle state and Task 3 ownership identity
- Produces deterministic status formatting for ownership, gateway, runtime/Desktop Commander, ngrok registration, lifecycle, last failure, restart attempt

- [ ] **Step 1: Write failing status matrix tests**

Cover:
- stopped/no owner;
- stale/invalid owner;
- supervisor alive + gateway unhealthy;
- supervisor healthy + runtime unavailable;
- recovering attempt N/5;
- terminal failure with last component/exit code;
- healthy local gateway + registered ngrok endpoint.

- [ ] **Step 2: Run connector tests to verify RED**

Run: `npm test -- tests/connector.test.ts`

Expected: FAIL on missing detailed status states.

- [ ] **Step 3: Implement status formatting from persisted/live evidence**

Do not claim public internet reachability unless actually tested; preserve the current explicit statement that public reachability is not tested.

- [ ] **Step 4: Re-run connector tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/connector.ts src/connector-supervisor.ts tests/connector.test.ts
git commit -m "feat: report connector component health"
```

### Task 12: Prove OAuth refresh crash consistency

**Files:**
- Modify: `src/connector-auth.ts`
- Modify: `tests/connector-auth-fixture.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Add test-only/injected persistence hooks at durable refresh-state boundaries without changing default production behavior.
- Preserve current encrypted on-disk OAuth state format unless the tests prove the existing format cannot meet the invariant.

- [ ] **Step 1: Add failing crash-before-commit test**

Simulate failure before the durable refresh rotation commit. After restart, assert the old token behavior matches the pre-commit state and no partially written replacement state is accepted.

- [ ] **Step 2: Add failing crash-after-commit test**

Allow durable commit of the consumed-token/replacement state, then simulate immediate process failure. After restart, assert the consumed old refresh token is rejected and the committed replacement remains authoritative.

- [ ] **Step 3: Add replay-family restart test**

Replay the consumed token after restart and assert family revocation behavior remains consistent with the current security model.

- [ ] **Step 4: Run OAuth connector tests to verify RED**

Run: `npm test -- tests/connector.test.ts`

Expected: at least one new injected crash-boundary assertion FAILS before production hooks/ordering are corrected.

- [ ] **Step 5: Implement the minimal crash-consistency seam/fix**

Keep refresh rotation ordering explicit: construct next state → durably commit → expose success. Never acknowledge a rotation whose durable state did not commit.

- [ ] **Step 6: Re-run connector tests**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/connector-auth.ts tests/connector-auth-fixture.ts tests/connector.test.ts
git commit -m "test: harden oauth refresh crash consistency"
```

### Task 13: Review dependency audit debt without adding CI

**Files:**
- Modify: `README.md` only if the repository already documents dependency/security debt
- Create: `docs/security/dependency-audit.md` only if a dedicated security note is more consistent than expanding README

**Interfaces:**
- Produces: current `npm audit` findings grouped by package/CVE or advisory, reachability assessment, upgrade/blocker status, and revisit guidance
- Does not change dependencies unless an upgrade is demonstrably compatible and covered by the full suite

- [ ] **Step 1: Capture fresh audit data**

Run: `npm audit --json`

Expected: machine-readable current findings.

- [ ] **Step 2: Trace findings to direct/transitive packages**

Record which findings come through `@wonderwhy-er/desktop-commander` or other dependency chains and whether vulnerable code paths are reachable in DevOS's use.

- [ ] **Step 3: Test safe upgrade candidates if available**

For any compatible patch/minor upgrade allowed by the project, update lockfile only after tests prove compatibility. Otherwise document why the version remains pinned.

- [ ] **Step 4: Run full verification after any dependency change**

Run: `npm run build && npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/security/dependency-audit.md package.json package-lock.json
git commit -m "docs: assess dependency audit debt"
```

Only add files that actually changed.

### Task 14: Full verification and manual browser acceptance

**Files:**
- No new production files unless verification exposes a defect
- Update tests only through a RED→GREEN fix if verification finds a real regression

**Interfaces:**
- Consumes every prior task
- Produces release/merge evidence

- [ ] **Step 1: Run TypeScript build**

Run: `npm run build`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 2: Run the full automated suite**

Run: `npm test`

Expected: all tests pass, zero failures.

- [ ] **Step 3: Run connector-local smoke coverage that is safe in the current environment**

Run only existing smoke commands whose prerequisites are available and which do not expose secrets. Record skipped smoke tests with the missing prerequisite.

- [ ] **Step 4: Perform the manual persistent-profile acceptance**

On macOS with the configured DevOS profile:
1. launch the profile manually in Chrome;
2. sign in to ChatGPT;
3. install/verify an extension;
4. close Chrome;
5. launch through DevOS;
6. verify the same account session remains;
7. verify the extension is present/enabled;
8. record whether HTTP 403 still occurs.

If 403 remains while identity persistence passes, record it as a separate unresolved browser/backend issue rather than rolling back the identity fix.

- [ ] **Step 5: Run final full suite after any verification fix**

Run: `npm run build && npm test`

Expected: PASS.

- [ ] **Step 6: Commit only if verification required a fix**

Use a narrowly scoped message naming the regression.

