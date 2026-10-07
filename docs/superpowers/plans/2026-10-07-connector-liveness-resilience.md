# Connector Liveness Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect hung-alive Desktop Commander processes and recover them while keeping request timeout, cancellation, and concurrency failures scoped to their individual MCP calls.

**Architecture:** Keep `connector-gateway.ts` as the host boundary and add a small single-flight watchdog module for backend state and heartbeat scheduling. The gateway must pass an immediate bounded ping before it listens, use independent request deadlines, expose backend liveness in `/health`, and feed backend failure into the existing supervisor callback. Process ownership, OAuth state, and Desktop Commander session semantics remain unchanged.

**Tech Stack:** TypeScript, Node.js 22+, `@modelcontextprotocol/sdk` 1.32.1, Node test runner, existing connector process fixtures.

**Spec:** `docs/superpowers/specs/2026-10-07-connector-request-liveness-design.md`

## Global Constraints

- Initial MCP `ping`: 5,000 ms, immediately after `local.connect()` and before HTTP listen/readiness.
- Heartbeat timeout: 5,000 ms; cadence: 15,000 ms from previous attempt start; maximum consecutive misses: 3; detection test limit: 40,000 ms from first failed heartbeat start.
- Heartbeats are single-flight and `onFailure("desktop_commander")` is single-shot per gateway instance.
- Service request absolute deadline: 60,000 ms.
- `tools/call` idle timeout: 60,000 ms, reset by progress; absolute deadline: 180,000 ms maximum.
- Backend state is `unknown | alive | suspect | stale/dead`; one or two misses are `suspect`, and recovery still starts only after three consecutive misses.
- Request timeout/cancellation do not restart the runtime; backend restart requires backend health failure or transport close.
- Preserve process ownership, bounded restart policy, OAuth state, `.env` handling, and stock Desktop Commander process/session tools.
- Add no CI, Keychain, new secret store, global daemon, process-name cleanup, infinite retry, or unbounded await.

## Review Focus

- Event loop delay or slow ping must not start overlapping heartbeat requests; test maximum one unresolved ping at a time.
- Initial ping failure must prevent the HTTP listener/readiness from appearing and be classified as `desktop_commander`.
- Timed-out/cancelled concurrent request A must not cancel request B, watchdog ping, or runtime.
- `/health` must report `suspect` after one or two misses, not report backend alive before initial ping or after the stale threshold, and must not expose process or secret details.
- SIGSTOP recovery must prove exact owned PID replacement, successful new MCP call, and absence of old/orphan children even when assertions fail.

---

### Task 1: Single-flight heartbeat state machine

**Files:**
- Create: `src/connector-watchdog.ts`
- Create: `tests/connector-watchdog.test.ts`

**Interfaces:**
- Produce `createConnectorWatchdog(options: { ping(timeoutMs: number): Promise<void>; onFailure(): void; initialSuccessAt: number; intervalMs?: number; timeoutMs?: number; failureThreshold?: number; now?: () => number })` returning `{ snapshot(): { state: "unknown" | "alive" | "suspect" | "stale/dead"; lastBackendOkAt?: string; consecutiveMisses: number }; stop(): Promise<void> }`. The initial success timestamp is supplied by gateway startup; optional shorter intervals/deadlines make state-machine tests fast without changing production defaults.
- Snapshot contains `state: "unknown" | "alive" | "suspect" | "stale/dead"`, `lastBackendOkAt?: string`, and `consecutiveMisses`.
- The gateway owns the immediate initial ping; the watchdog starts only after that ping succeeds.

- [x] **Step 1: Add failing tests for heartbeat schedule, failure threshold, reset, and single flight.** Assert 15-second start-to-start cadence, 5-second ping deadline, no overlapping pings while unresolved, one/two misses do not fail, success resets misses, and the third miss calls `onFailure` once.
- [x] **Step 2: Run `npx tsx --test tests/connector-watchdog.test.ts` and confirm the new tests fail because the module is absent.**
- [x] **Step 3: Implement `createConnectorWatchdog` with 15,000 ms cadence, 5,000 ms per-attempt deadline, 3-miss threshold, and idempotent stop.** Ensure an overdue scheduled tick waits for the active attempt instead of overlapping it.
- [x] **Step 4: Run `npx tsx --test tests/connector-watchdog.test.ts`; expect all state-machine tests to pass.**
- [x] **Step 5: Commit the watchdog module and tests.**

### Task 2: Startup proof, health response, and backend failure wiring

**Files:**
- Modify: `src/connector-gateway.ts`
- Modify: `src/connector.ts` only if a health consumer needs to report gateway readiness separately from backend liveness.
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Consume `createConnectorWatchdog` from Task 1.
- `startGateway` continues to return its current gateway handle; `/health` adds backend state and `lastBackendOkAt` without exposing PID, command line, secrets, or paths.

- [x] **Step 1: Extend controlled-stdio tests to assert no HTTP listener/readiness exists until the immediate ping succeeds, after which `/health` reports backend `alive` and a timestamp. Add an initial-ping-hang fixture and assert startup fails within 5 seconds as `desktop_commander`, before the HTTP listener exists.**
- [x] **Step 2: Run the focused gateway tests and confirm the new health/startup assertions fail.**
- [x] **Step 3: Run immediate `local.ping({ timeout: 5_000 })` after connect and before `app.listen`; classify failure as `desktop_commander`. On success, start watchdog, derive `/health` backend fields from the state snapshot, and gate `onFailure` through one per-gateway latch shared with `local.onclose`.**
- [x] **Step 4: Test one missed ping followed by a successful ping, three missed pings with one failure callback, failure callback racing `onclose`, and clean intentional close without failure callback.**
- [x] **Step 5: Run focused tests and commit gateway readiness/wiring.**

### Task 3: Per-request deadlines and independent cancellation

**Files:**
- Modify: `src/connector-gateway.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- No wire/API changes. Forwarded local requests keep the inbound `AbortSignal`; use MCP request options `timeout`, `resetTimeoutOnProgress`, and `maxTotalTimeout`. Add an internal `startGateway` timeout override for tests only; production defaults remain fixed at the values in Global Constraints.

- [x] **Step 1: Extend the controllable stdio fixture with delayed/pending tools, progress, request IDs, and overlap tracking. Add tests for a 60-second service deadline, a 60-second idle deadline, the 180-second absolute tool deadline, and progress resetting only the idle deadline. Use injectable short test budgets where needed; assert production constants separately.**
- [x] **Step 2: Add regression tests: cancel A then B succeeds; timeout A while B and ping succeed; two read-only requests run concurrently; long A does not block quick B; cancelling one concurrent request leaves the other successful and runtime PID unchanged.**
- [x] **Step 3: Run focused connector tests and confirm timeout/deadline/concurrency assertions fail before the gateway change.**
- [x] **Step 4: Set service request `timeout` and `maxTotalTimeout` to 60,000 ms. Set `tools/call` `timeout` to 60,000 ms, `resetTimeoutOnProgress: true`, and `maxTotalTimeout` to 180,000 ms. Keep `signal: extra.signal`; do not invoke backend failure on request-local timeout/cancel.**
- [x] **Step 5: Run focused gateway tests and commit request lifecycle changes.**

### Task 4: Bounded shutdown with pending requests

**Files:**
- Modify: `src/connector-gateway.ts`
- Modify: `src/connector.ts` if runtime shutdown sequencing needs adjustment.
- Modify: `tests/connector.test.ts`

**Interfaces:**
- `gateway.close()` remains idempotent and returns `Promise<void>`.

- [x] **Step 1: Add a controlled-stdio test that holds a tool request open, invokes `gateway.close()` twice, and asserts both close calls settle within a bounded test deadline, the client sees a bounded failure, and no new backend failure/restart callback is emitted.**
- [x] **Step 2: Run the shutdown test and confirm it fails against the unbounded/current close sequence.**
- [x] **Step 3: Stop watchdog scheduling first; stop accepting HTTP work; close sessions/server; bound gateway-owned pending work and `local.close()`; leave final owned process-group escalation to runtime/runner.**
- [x] **Step 4: Add coverage for local transport close that never resolves and assert runtime process-group cleanup still finishes.**
- [x] **Step 5: Run gateway/lifecycle tests and commit bounded shutdown changes.**

### Task 5: Real process fault injection and recovery proof

**Files:**
- Modify: `tests/connector-process-fixture.ts`
- Modify: `tests/connector.test.ts` or create `tests/connector-watchdog.integration.test.ts`
- Modify: `tests/connector-local.smoke.ts` if needed for host connector smoke.
- Modify: `docs/superpowers/specs/2026-10-07-connector-request-liveness-design.md` only to record verified final matrix and any remaining upstream limitation.

**Interfaces:**
- Consume the watchdog and gateway behavior from Tasks 1–4; exercise the existing supervisor/runner without changing process ownership rules.

- [x] **Step 1: Add a Unix process fixture that exposes the exact owned Desktop Commander child PID and supports deterministic MCP calls before/after replacement. Install `finally` cleanup that SIGCONTs only a still-owned stopped PID before bounded termination.**
- [x] **Step 2: Write a process-level SIGSTOP test. Assert the child remains alive and stdio open; detection occurs within 40,000 ms of the first failed heartbeat start; failure component is `desktop_commander`; runtime/supervisor replaces the child; a new MCP `tools/list` or `get_config` succeeds; the old PID is gone; no fixture process remains.**
- [x] **Step 3: Add process fault cases for Desktop Commander SIGKILL/stdio EOF, ngrok death, runtime death, and shutdown with pending calls; assert each reports the correct component and obeys restart budget/cleanup.**
- [x] **Step 4: Exercise OAuth state continuity across runtime replacement, a new authenticated HTTP session, rejection of the stale session, and `start_process`/`read_process_output` semantics against the pinned Desktop Commander.**
- [x] **Step 5: Run targeted connector supervisor, lifecycle, gateway, cancellation, concurrency, shutdown, ownership, and SIGSTOP tests; commit integration coverage.**

### Task 6: Dependency review, full verification, and final report

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-connector-request-liveness-design.md` with verified results and any unproven cases.
- Modify dependency manifests only if a specific compatible upstream release is proven to fix a required behavior and all gates pass.

- [x] **Step 1: Review current pinned Desktop Commander 0.2.52 against published releases for process wait, stdio reliability, cancellation, output bounds, cleanup, and readiness. Record the version/release evidence; do not upgrade without a compatible API and passing smoke.**
- [x] **Step 2: Run `npm ci`, `npm run build`, and `npm test`; require 0 fail, 0 cancelled, and 0 todo.**
- [x] **Step 3: Run the real connector smoke, including authenticated `tools/list`, simple tool call, owned Desktop Commander SIGSTOP/recovery/new call, and ngrok kill/recovery/new call.**
- [x] **Step 4: Capture process snapshots before and after; verify zero fixture connector, Desktop Commander, ngrok, runtime/runner orphans and zero temporary connector directories. Confirm production connector is intentionally stopped or healthy and owned.**
- [x] **Step 5: Verify `git status`, `git diff --check`, `git check-ignore -v .env`, and `git ls-files .env`; `.env` must be ignored and untracked.**
- [x] **Step 6: Update the fault matrix with PASS/FAIL/evidence, baseline and final SHA, changed files, verification output, dependency finding, final connector status, and any scenario that could not be proven. Commit the final documentation.**

## Final verification commands

```bash
npm ci
npm run build
npm test
git diff --check
git check-ignore -v .env
git ls-files .env
```
