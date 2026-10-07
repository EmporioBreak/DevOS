# DevOS Reliability Hardening Design

## Goal

Harden DevOS around browser identity persistence, connector self-healing, process ownership, task exclusivity, state durability, orchestration limits, output retention, workflow repository safety, connector credential loading, and OAuth crash consistency without changing DevOS's main-agent ownership model.

Two explicit product decisions apply to this work:

- Do not add GitHub Actions or any CI workflow.
- Do not add macOS Keychain integration. Connector secrets are loaded from `.env`, with process environment variables taking precedence.

## Current problems

The current implementation has several independent failure modes that can compound:

1. Playwright launches the persistent Chrome profile with Playwright default arguments, including defaults that can disable extensions and alter credential/keychain behavior. A profile that works when Chrome is launched manually can therefore appear fresh when DevOS launches it.
2. The connector background runner is effectively one-shot. An unexpected ngrok/runtime/transport exit ends the connector rather than recovering it within a bounded restart policy.
3. Background ownership is identified primarily by PID. A stale PID file can point at a later unrelated process.
4. A DevOS task can be launched twice concurrently, and state writes are not independently safe against concurrent writers.
5. Workflow files are not required to match the checked-out repository.
6. The orchestration loop has no explicit worker-run/review-loop/wall-clock ceiling.
7. Command stdout/stderr are retained without a hard memory bound.
8. The launcher uses non-reproducible dependency installation in some paths.
9. Connector diagnostics are too coarse to distinguish recovering, degraded, or terminally failed states.
10. OAuth refresh rotation needs explicit crash-boundary regression coverage.

## Non-goals

This change does not:

- change the main-agent final approval flow;
- add a global daemon, LaunchAgent, login service, or unbounded watchdog;
- add GitHub Actions;
- add Keychain integration;
- weaken browser fail-closed behavior;
- silently create replacement ChatGPT conversations when a saved same-task session disappears;
- redesign the OAuth protocol or remove its existing AES-GCM, PKCE, resource binding, refresh rotation, or replay-family revocation behavior.

## Architecture

### 1. Browser launch identity

The persistent browser remains a Playwright-owned persistent Chrome context using the configured profile directory.

DevOS will explicitly control the subset of Playwright default arguments that conflict with reuse of a manually prepared Chrome identity. The launch configuration will suppress the relevant defaults rather than replacing the entire Playwright argument set.

The initial suppressed defaults are:

- `--disable-extensions`
- `--disable-component-extensions-with-background-pages`
- `--use-mock-keychain`
- `--password-store=basic`
- `--disable-sync`

This list lives in browser configuration code and is covered by tests so later Playwright upgrades cannot silently restore the incompatible behavior.

Acceptance behavior:

1. Open the configured DevOS profile manually in Chrome.
2. Sign in to ChatGPT.
3. Install an extension.
4. Close Chrome.
5. Start the browser through DevOS.
6. The same account session remains available.
7. The installed extension remains present and enabled.
8. DevOS still preserves its existing browser session fail-closed rules.

HTTP 403 from the ChatGPT backend is treated as a separate diagnostic problem. The identity fix must land first. If 403 remains afterward, DevOS reports it without conflating it with profile persistence.

### 2. Connector supervision

Introduce a project-scoped bounded supervisor around the connector runtime.

The supervisor owns the runtime process group and tracks a small lifecycle state machine:

- `starting`
- `healthy`
- `recovering`
- `degraded`
- `terminal_failed`
- `stopped`

Unexpected runtime exit triggers recovery with a finite restart budget and backoff. Defaults:

- maximum restart attempts: 5
- backoff sequence: 2s, 5s, 10s, 20s, 30s
- successful healthy operation resets the consecutive-failure budget after a stable interval

When the budget is exhausted, the supervisor remains alive only long enough to persist terminal diagnostics and then exits cleanly. There is no infinite restart loop.

Connector state records bounded diagnostic metadata, never secrets or request payloads:

- lifecycle status
- last failure component
- last failure timestamp
- last exit code/signal
- current restart attempt and maximum
- local gateway health
- ngrok registration state
- runtime PID identity metadata

The existing project-local ownership model remains unchanged.

### 3. Process ownership

PID alone is not authoritative.

A process identity record contains:

- PID
- process start time
- executable path
- project root
- random ownership token
- expected runtime marker/command identity where available

Before DevOS sends SIGTERM or SIGKILL to a stored PID, it re-reads the live process identity and compares it with the persisted ownership record.

If ownership cannot be proven, DevOS does not signal the process. It reports stale/ambiguous ownership and cleans only state that can be proven safe to remove.

The same identity helper is reused for:

- connector background process ownership;
- stale task-lock validation.

### 4. Connector credentials

Connector credentials are loaded in this precedence order:

1. process environment;
2. project `.env`;
3. explicit missing-credential error.

Required values remain:

- `DEVOS_CONNECTOR_OWNER_SECRET`
- `NGROK_AUTHTOKEN`

The `.env` file is project-local and must be ignored by git. DevOS does not print secret values, persist them in connector JSON state, pass them in argv, include them in process titles, or send them to GitHub.

Parsing is deliberately minimal: standard `KEY=value` lines, optional surrounding quotes, comments, and blank lines. It is not a general shell evaluator.

### 5. Per-task execution lock

Before orchestration state is read or modified, DevOS acquires an exclusive lock for the repository/issue pair.

Lock state contains:

- repo
- issue
- PID
- process identity
- run ID
- startedAt

The lock is created atomically with exclusive-create semantics.

If a valid owner already holds the lock, a second invocation fails with a clear message naming the issue and owning DevOS PID.

If the stored owner is gone or its process identity no longer matches, the lock is stale and may be removed safely before acquisition.

Lock release happens in `finally`. A crash leaves a stale lock that the next run validates before removal.

### 6. Durable state writes

`JsonStateStore` writes to a unique temporary file in the same directory, for example:

`state.json.tmp.<pid>.<random>`

The file is then atomically renamed over the destination.

This makes the store resilient to temp-file collisions even if another bug bypasses the execution lock.

### 7. Workflow repository guard

Every workflow execution validates:

`workflow.task.repo === projectConfig.repo`

This applies equally to issue-loaded workflows and explicitly supplied workflow JSON files.

Mismatch is a hard error before any worker launches or task state mutates.

Cross-repository execution is not introduced in this change.

### 8. Orchestration budgets

Add explicit configurable safety ceilings with conservative defaults:

- `maxWorkerRuns = 30`
- `maxReviewLoops = 8`
- `maxWallClockDurationMs = 6h`

The wall-clock origin is persisted in run state so resume does not reset the budget.

A review loop is counted when a `changes_requested` route sends execution back into implementation/rework.

Exceeding any budget produces an explicit terminal failure with the exceeded budget named. It does not silently stop and does not continue looping.

### 9. Bounded command output

`LocalCommandRunner` continues streaming complete stdout to incremental consumers while bounding retained output.

Retained stdout/stderr use a bounded head+tail strategy:

- first 64 KiB
- last 1 MiB

The command result includes truncation metadata so callers and diagnostics know when output was abbreviated.

Completion detection and streaming callbacks continue to operate on the live stream rather than only the retained tail.

Debug logging records bounded retained output only.

### 10. Reproducible dependency installation

All launcher paths that install from the checked-in lockfile use `npm ci` instead of `npm install --no-package-lock`.

Connector bootstrap keeps `--ignore-scripts` where it is currently part of the security boundary.

No GitHub Actions workflow is added.

### 11. Connector status and diagnostics

`connector status` reports lifecycle state rather than equating PID existence with health.

At minimum it distinguishes:

- supervisor ownership valid/invalid
- gateway local health
- Desktop Commander/runtime process state
- ngrok registration state
- lifecycle status
- last failure component/reason
- restart attempt if recovering

Local bounded connector diagnostics are written under `.devos/logs/` or the existing connector state/log area using size-bounded or rotation-bounded storage.

Secrets, bearer tokens, OAuth codes, request bodies, and raw MCP payloads are excluded.

### 12. OAuth crash consistency

Keep the existing OAuth design.

Add test seams around durable refresh-state persistence so regression tests can simulate failure at the refresh-rotation boundaries.

The required invariant is:

Once a refresh token has been consumed and the replacement state has reached the durable commit point, a process restart must never make the consumed token valid again.

Tests cover failure before durable commit, at commit boundaries that can be injected safely, and restart after a successful committed rotation.

## File structure

Expected new focused modules:

- `src/process-identity.ts` — live process identity capture and equality checks
- `src/task-lock.ts` — per-task exclusive ownership
- `src/connector-supervisor.ts` — bounded runtime recovery state machine
- `src/connector-env.ts` — safe `.env` parsing and connector credential resolution
- optional small output-retention helper if keeping it inside `command-runner.ts` would make the runner unclear

Existing files to modify include:

- `src/browser-config.ts`
- `src/chatgpt-browser-executor.ts`
- `src/connector.ts`
- `src/connector-runner.ts`
- `src/json-state-store.ts`
- `src/orchestrator.ts`
- `src/cli.ts`
- `src/command-runner.ts`
- `devos`
- `.gitignore`
- relevant tests

The implementation should follow existing repository patterns and avoid unrelated refactoring.

## Testing strategy

Every behavioral fix is implemented test-first.

Required regression coverage includes:

- browser launch suppresses the identity-breaking Playwright defaults;
- browser fail-closed/session invariants remain unchanged;
- connector recovers from an unexpected runtime exit within budget;
- connector enters `terminal_failed` after exhausting restart budget;
- stop refuses to kill a live PID whose identity does not match;
- stale matching connector ownership can be cleaned safely;
- `.env` credential loading and process-env precedence;
- secrets are absent from persisted connector state/log fixtures;
- concurrent task acquisition rejects the second live owner;
- stale task locks are recoverable only after identity validation;
- state writes use unique temp paths and atomic rename;
- workflow repository mismatch fails before executor invocation;
- each orchestration budget terminates explicitly;
- retained command output is bounded while stream callbacks still see complete incremental output;
- launcher uses `npm ci`;
- refresh rotation remains replay-safe across simulated crash/restart boundaries.

Final verification:

- `npm run build`
- `npm test`

Manual browser acceptance is additionally required for the persistent-profile behavior because unit tests cannot prove Chrome account/keychain/extension persistence end-to-end.

## Rollout order

1. Browser identity launch fix and regression tests.
2. Re-test real ChatGPT login/extension persistence; record whether HTTP 403 still reproduces.
3. Process identity primitive.
4. Connector supervisor, lifecycle state, diagnostics, and safe stop.
5. `.env` connector credential loading.
6. Per-task execution lock.
7. Unique atomic state temp files.
8. Workflow repository mismatch guard.
9. Orchestration budgets.
10. Bounded command output.
11. Launcher migration to `npm ci`.
12. OAuth crash-boundary tests.
13. Dependency audit review and documented reachability/upgrade findings.

## Compatibility and safety constraints

- Node.js remains >=22.
- Existing CLI command names and normal `run` / `restart` semantics remain intact.
- No global daemon or OS login service is introduced.
- No GitHub Actions are introduced.
- Connector supervision is bounded.
- Ambiguous process ownership always fails closed.
- Browser session recovery remains fail-closed for missing same-task conversations.
- Existing main-agent finalization ordering remains unchanged.
- Existing OAuth security properties are preserved.
