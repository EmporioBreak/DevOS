# Desktop Commander upstream parity implementation plan

> **For agentic workers:** This task is being executed natively in the current session. Follow the plan task by task. Keep changes test-first and commit each completed task.

**Goal:** Make DevOS's local Desktop Commander adapter match upstream v0.2.52 behavior where applicable while preserving DevOS's public gateway, supervisor and hung-child recovery.

**Architecture:** Extract local stdio/client ownership, readiness, typed MCP calls, watchdog and bounded shutdown into `DesktopCommanderIntegration`. Keep HTTP, OAuth, public sessions, public request bounds and requester-scoped progress in `connector-gateway.ts`; retain the existing supervisor as the only restart owner.

**Tech Stack:** TypeScript, Node.js 22, `@modelcontextprotocol/sdk` 1.32.1, stock `@wonderwhy-er/desktop-commander` 0.2.52, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-07-desktop-commander-upstream-parity-audit.md` and the user-provided task in the conversation.

## Global Constraints

- Keep `@wonderwhy-er/desktop-commander` pinned at `0.2.52` unless a reproducible failure justifies changing it.
- Launch local Desktop Commander with `DC_REMOTE_DEVICE=true` and `desktop-commander-client` / `1.0.0` client identity.
- Add `_meta.remote=true`; pass only request-relevant metadata that is safe to forward.
- Keep child environment allowlisted; `.env` stays ignored and untracked.
- Keep single-flight watchdog at 15-second cadence, 5-second timeout and three consecutive misses.
- Preserve 60-second service timeout, 60-second progress-resettable tool idle timeout and 180-second total tool timeout.
- Do not add CI, Keychain, another secret store, a global daemon, name-based process cleanup, unbounded retries or terminal session logic.
- Do not modify browser/Camoufox behavior or unrelated connector lifecycle code.

## Review Focus

1. Environment merge must add upstream defaults and the remote flag without forwarding connector secrets. Test the effective child environment with sentinel values.
2. A notification flood must not block requests or grow queued public writes. Test a bounded flood concurrent with list, tool and ping calls.
3. Request metadata and progress must remain isolated across concurrent public sessions. Test distinct progress tokens and cancellation of one request.
4. A child that closes during initialization or shutdown must not leave an owned process behind. Test failed `listTools()`, racing close, and bounded transport cleanup.
5. A timeout or protocol `onerror` must not count as backend death while heartbeat succeeds. Test that no supervisor failure is reported.

---

### Task 1: Extract the local Desktop Commander adapter

**Files:**
- Create: `src/desktop-commander-integration.ts`
- Modify: `src/connector-gateway.ts`
- Test: `tests/desktop-commander-integration.test.ts`
- Modify: `tests/connector.test.ts`

**Interfaces:**
- Produces `DesktopCommanderIntegration` with `initialize()`, `listTools()`, `callTool(params, options)`, `ping(timeoutMs)`, `request(method, params, options)`, `snapshot()`, `onDisconnect(handler)` and idempotent bounded `close()`.
- `initialize()` connects, runs bounded `listTools()` readiness, and starts the watchdog only after readiness succeeds.
- Gateway receives the adapter through normal construction; it no longer creates or closes `Client` or `StdioClientTransport` directly.

- [ ] Add failing tests for adapter readiness, disconnect callback, idempotent close and gateway startup failure cleanup.
- [ ] Run `node --import tsx --test tests/desktop-commander-integration.test.ts` and confirm expected failures.
- [ ] Move local process/client lifecycle out of gateway with no change to OAuth or HTTP session behavior.
- [ ] Run adapter and gateway tests plus `npm run build`.
- [ ] Commit `refactor: extract Desktop Commander integration adapter`.

### Task 2: Match upstream launch, identity and request metadata

**Files:**
- Modify: `src/desktop-commander-integration.ts`
- Modify: `src/connector-gateway.ts`
- Test: `tests/desktop-commander-integration.test.ts`
- Test: `tests/connector.test.ts`

**Interfaces:**
- Adapter launch uses current `desktopCommand(root)`, cwd and the safe environment plus `DESKTOP_COMMANDER_DISABLE_TELEMETRY=1` and `DC_REMOTE_DEVICE=true`.
- Local `Client` identity is `desktop-commander-client` / `1.0.0`; public server identity remains DevOS's public identity.
- `callTool` receives `_meta.remote=true` and only safe, relevant inbound metadata.

- [ ] Add tests for effective inherited/overridden env, no connector secrets, client identity and remote metadata.
- [ ] Verify the new tests fail for the current behavior.
- [ ] Implement upstream parity without changing the pinned package.
- [ ] Run focused tests and build.
- [ ] Commit `fix: match upstream Desktop Commander launch semantics`.

### Task 3: Separate local notifications from public progress

**Files:**
- Modify: `src/desktop-commander-integration.ts`
- Modify: `src/connector-gateway.ts`
- Test: `tests/desktop-commander-integration.test.ts`
- Test: `tests/connector.test.ts`

**Interfaces:**
- Adapter reports local notification counts by method but does not broadcast them.
- Gateway forwards `notifications/progress` only through the originating request's callback and progress token.
- `notifications/message` and unrelated notifications do not create public session writes.

- [ ] Add failing tests for message flood isolation, concurrent session progress routing and request cancellation isolation.
- [ ] Verify those tests fail because of the current fan-out or metadata behavior.
- [ ] Remove session-wide notification fan-out; preserve request-scoped progress and cancellation.
- [ ] Run focused tests and build.
- [ ] Commit `fix: keep Desktop Commander notifications request scoped`.

### Task 4: Preserve request bounds and diagnostics across the adapter boundary

**Files:**
- Modify: `src/desktop-commander-integration.ts`
- Modify: `src/connector-gateway.ts`
- Modify: `src/connector-diagnostics.ts` only if existing diagnostics cannot represent the new counters safely
- Test: `tests/desktop-commander-integration.test.ts`
- Test: `tests/connector.test.ts`

**Interfaces:**
- `tools/list`, `tools/call` and `ping` use typed adapter methods; other currently advertised methods use an explicit bounded forwarding method.
- Per-request timeout/cancel is isolated from watchdog health.
- Diagnostics are payload-free and bounded to 50 recent request lifecycle events plus notification counts, active request count, last successful ping and process identity/usage where available.

- [ ] Add failing tests for concurrent calls, timeout with healthy heartbeat, `onerror` without restart, bounded request event history and no payload capture.
- [ ] Verify expected failures.
- [ ] Implement typed forwarding and bounded instrumentation without changing external timeout values.
- [ ] Run focused tests and build.
- [ ] Commit `feat: add bounded Desktop Commander lifecycle diagnostics`.

### Task 5: Prove cleanup, watchdog recovery and notification flood behavior

**Files:**
- Modify: `tests/connector-watchdog.integration.test.ts`
- Modify: `tests/connector-process-fixture.ts`
- Create or modify: `tests/desktop-commander-stress.test.ts`
- Modify production files only when a failing test demonstrates a defect.

**Interfaces:**
- Existing process ownership and supervisor APIs remain authoritative.
- Test backends can emit many `notifications/message` events and can be stopped or killed by the exact owned PID.

- [ ] Add fixture tests for initialization failure cleanup, close races, notification flood under concurrent requests and bounded memory/queued work.
- [ ] Add same-load comparisons for stock upstream-style launch and the final public DevOS path: 100+ `get_config`, 100+ `tools/list`, short process start/poll cycles, concurrent reads, cancellation, bounded output and idle periods.
- [ ] Run controlled `SIGSTOP` and `SIGKILL` recovery tests. Require old PID exit, fresh MCP request success, no watchdog restart during normal load and no orphan children.
- [ ] Commit `test: cover Desktop Commander parity and fault recovery`.

### Task 6: Full verification and live-host evidence

**Files:**
- Modify the parity audit with final evidence and any justified deviations.

- [ ] Run `npm ci`, `npm run build` and `npm test`; record exact results.
- [ ] Run local real Desktop Commander smoke tests for `get_config`, `tools/list`, `read_file`, short `start_process` and subsequent `read_process_output`.
- [ ] Run isolated public-path/OAuth tests where credentials are available without copying or logging secrets; verify stale sessions fail closed.
- [ ] Capture process snapshots before and after controlled failure; confirm no orphan processes and `.env` remains ignored/untracked.
- [ ] Run public ngrok recovery only against an isolated/controlled endpoint; do not fault the existing production connector during ordinary-load tests.
- [ ] Update the audit's parity matrix and unresolved findings; commit `docs: record Desktop Commander parity verification`.

## Self-review coverage

- User-specified parity topics map to Tasks 1–4 and the audit matrix.
- Notification flood and public session isolation map to Tasks 3 and 5.
- Stock package decision, normal-load stability, SIGSTOP recovery and no-orphan checks map to Tasks 5 and 6.
- Repository safety, `.env`, no CI, no Keychain and no process-name cleanup are global constraints and are checked in Task 6.
