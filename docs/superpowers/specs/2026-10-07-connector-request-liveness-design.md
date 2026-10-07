# Connector Request Liveness Design

## Goal

Make the DevOS MCP connector distinguish an unresponsive Desktop Commander backend from a slow, timed-out, or cancelled individual request. Preserve the existing supervisor, process ownership, restart budget, OAuth state, and stock `@wonderwhy-er/desktop-commander` integration.

Baseline: `80c50a79a14e19df3f01f613f77d57a04a23a8d3` (`main` and `origin/main` matched during discovery).

## Current behavior

`src/connector-gateway.ts` owns one MCP `Client` over `StdioClientTransport`. Its `onclose` callback reports `desktop_commander` failure, but no independent backend liveness request exists. The HTTP `/health` currently reports only whether the OAuth provider is configured. Requests are forwarded with the inbound MCP `AbortSignal`, but no gateway-specific idle or absolute deadline is set. `gateway.close()` closes HTTP sessions and the MCP client without its own deadline; the runtime/runner provide process-group cleanup.

The pinned MCP SDK 1.32.1 exposes `Client.ping()` and request options for `signal`, `timeout`, `resetTimeoutOnProgress`, and `maxTotalTimeout`. The pinned Desktop Commander is 0.2.52. Its upstream repro labels `maxProcessWaitMs` as a desired behavior that current code does not meet, so an upgrade cannot be assumed to fix long-running calls.

## Design

### Backend liveness

- Immediately after `local.connect()`, send a bounded initial MCP `ping` with a 5-second timeout. Do not listen for HTTP traffic or report the gateway ready until it succeeds. An initial ping failure aborts gateway startup as a `desktop_commander` failure.
- After the initial ping, run one watchdog independently of HTTP requests. Schedule attempts on a 15-second cadence measured from the previous attempt's start time. Heartbeats are single-flight: never start a new ping while the previous attempt is unresolved; after it settles, resume the start-based cadence without overlapping requests.
- Count consecutive failed or timed-out pings; reset the count on success. Three consecutive misses report `onFailure("desktop_commander")` once per gateway instance. A single missed ping does not restart the runtime. Failure reporting is single-shot even when `onclose`, heartbeat failure, or shutdown race to report it.
- With a 15-second start-to-start cadence and 5-second timeout, the third miss is detected at approximately 35 seconds after the first failed attempt begins. The SIGSTOP integration test must assert detection within 40 seconds of the first failed attempt, including a 5-second scheduling margin.
- Stop the watchdog before beginning gateway shutdown. Ignore late ping completions after close.
- Track backend state internally as `unknown | alive | suspect | stale/dead`; `local.connect()` alone does not prove liveness. After the initial ping, store `lastBackendOkAt` and mark alive. One or two consecutive missed heartbeats mark the backend suspect; the third marks it stale/dead and triggers recovery. `/health` reports gateway/provider readiness separately from backend liveness and the last successful backend check. Before the initial successful ping or while no successful ping is known, it must not claim backend health. The public response contains no PID, command line, secret, or internal path; suspect and stale/dead states make backend liveness false.

### Request lifecycle

- Keep the inbound cancellation signal connected to the corresponding forwarded local request. Cancellation and request timeout are request-local and do not call `onFailure`.
- Bound service requests such as `ping`, `tools/list`, and discovery/readiness operations to at most 60 seconds.
- For `tools/call`, use a finite idle timeout with progress resetting that idle timeout and a default absolute maximum no greater than 180 seconds. Keep the proxy deadline below the lowest confirmed client-side ceiling. This gives calls time to report progress without letting the external client time out first or allowing an endless RPC. Do not transform a timeout into a backend failure; independent pings decide backend health.
- For `start_process` and analogous Desktop Commander operations, preserve the upstream process/session handoff: return PID/session promptly and use `read_process_output` for later output. Do not use the proxy deadline as the intended long-process wait strategy.
- Verify concurrent requests remain multiplexed over the MCP client: cancelling/timing out request A must not prevent request B or watchdog pings from completing.
- Preserve Desktop Commander process/session tools. Do not implement terminal sessions in DevOS or rewrite tool results to imitate upstream long-process support. If the pinned release blocks a required call despite its process/session contract, record the evidence as a blocker and assess a narrowly scoped dependency upgrade separately.

### Shutdown and recovery

- Make gateway close idempotent. Stop watchdog scheduling, abort/settle in-flight gateway-owned work where supported, close HTTP sessions and server, and close the local MCP client/stdio transport within bounded waits.
- Preserve runtime and runner process-group escalation as the final cleanup boundary. Never kill by process name or broaden ownership checks.
- Watchdog failure uses the existing `onFailure` → runtime stop → supervisor restart path. Intentional shutdown must not be reported as backend failure or trigger a restart.
- Preserve OAuth client/state files across runtime replacement; a new HTTP session must initialize/authenticate against the replacement runtime, while stale sessions fail closed.

## Failure semantics

| Event | Request result | Backend health | `onFailure` | Runtime restart |
|---|---|---|---|---|
| One tool request times out; ping succeeds | Bounded request error | Alive | No | No |
| One request is cancelled; ping succeeds | Cancel that request | Alive | No | No |
| One ping misses | Active requests unaffected | Suspect until next result | No | No |
| Three consecutive pings miss | Pending calls fail as transport closes | Dead | `desktop_commander` once | Yes, through supervisor |
| Stdio closes/exits unexpectedly | Pending calls fail | Dead | `desktop_commander` once | Yes |
| Gateway/runtime intentional close | Pending work settles boundedly | Stopped | No | No |

## Test matrix

| Fault or behavior | Expected detection | Failure component | Restart | Postcondition |
|---|---|---|---|---|
| Ping success after one miss | Next ping interval | none | no | backend remains usable |
| Owned Desktop Commander receives SIGSTOP | ≤ 40 seconds from first failed heartbeat start (15-second start-to-start cadence, 5-second timeout, 5-second scheduling margin) | desktop_commander | yes | new MCP request succeeds; old owned PID is gone |
| Desktop Commander SIGKILL / stdio EOF | transport close | desktop_commander | yes | new request succeeds |
| ngrok SIGTERM / hang on SIGTERM | existing bounded runner path | ngrok | yes | endpoint re-registers; no orphan |
| Runtime SIGKILL | supervisor observes child exit | runtime | yes | new request succeeds |
| One request hangs while ping succeeds | request absolute deadline | none | no | another request and ping succeed |
| Request cancellation | request signal | none | no | following request succeeds; runtime PID stable |
| Two concurrent read-only calls | both responses | none | no | both succeed |
| Long call plus quick call | quick response remains independent | none if ping succeeds | no | long call is bounded; quick call succeeds |
| Cancel one of two calls | only that request | none | no | other call completes |
| Multiple pending calls plus backend hang | watchdog threshold | desktop_commander | yes | all old calls settle; new call succeeds |
| Gateway shutdown with pending calls | bounded close deadline | none | no | no child or temp state orphan |
| Repeated/mixed backend failures | supervisor budget and stable reset | actual component | according to budget | `terminal_failed` is never healthy; manual restart works |
| OAuth runtime replacement | after recovery | none | already restarted | OAuth state survives; new session works; stale session rejected |
| `start_process` + output polling | MCP behavior | none | no | process session survives bounded tool return and output is readable |

## Dependency and upstream review

Do not upgrade Desktop Commander merely to latest. Compare the current pin with releases relevant to process wait, stdio, cancellation, output bounds, cleanup, and readiness. Upgrade only with a compatible API, understandable diff, passing DevOS suite, and connector smoke. The upstream process-wait repro is evidence of an unmet desired contract in its current target, not proof that a released fix exists.

Operational patterns to adapt from upstream are explicit heartbeat freshness, a watchdog independent from request handling, bounded recovery, reentrancy protection, and separate transport liveness from readiness. Do not copy its remote-channel implementation into DevOS.

Reviewed upstream sources:

- [`remote-channel.ts`](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/remote-channel.ts) — heartbeat freshness, stale detection, bounded recreate, and reentrancy guard.
- [`desktop-commander-integration.ts`](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/desktop-commander-integration.ts) and [`device.ts`](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/device.ts) — local executor readiness and transport/readiness separation.
- [`terminal-manager.ts`](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/terminal-manager.ts) — process/session lifecycle primitives.
- [`test-process-wait-client-cap.js`](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/test/repro/test-process-wait-client-cap.js) — explicitly documents a desired process-wait cap and says the repro fails against current code; this is not evidence of a released production fix.

Dependency review on 2026-10-07: the lockfile pin is `0.2.52`, and the npm `latest` dist-tag is also `0.2.52`. The [v0.2.44 release notes](https://github.com/wonderwhy-er/DesktopCommanderMCP/releases/tag/v0.2.44) already document an abortable three-minute cap for multi-minute tool calls under parallel load; the later pinned release includes that change. The [v0.2.52 release notes](https://github.com/wonderwhy-er/DesktopCommanderMCP/releases/tag/v0.2.52) describe remote readiness and pending-call recovery work, but do not claim to fix a hung local stdio process. The [upstream stdio initialization issue](https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/796) reports a live/no-output hang on Windows with `0.2.47` and `0.2.51`; it does not establish that `0.2.52` fixes that issue or that the same defect occurs on macOS/Linux. No dependency change is justified.

## Constraints and exclusions

- Keep `.env` as the secret source; ensure it remains ignored and untracked.
- No GitHub Actions/CI, Keychain, new secret store, global daemon, global process-name cleanup, infinite retry, or unbounded await.
- Do not fork or reimplement Desktop Commander terminal/process sessions.
- Do not mix in browser migration or unrelated connector cleanup.

## Acceptance evidence

Implementation is complete only after `npm ci`, `npm run build`, and full `npm test` pass; targeted gateway/supervisor/lifecycle/cancellation/concurrency/shutdown/ownership checks pass; connector smoke includes owned-process SIGSTOP recovery and post-recovery MCP request; process snapshots show no connector/DC/ngrok/runtime/runner or fixture orphans; and `.env` is ignored and untracked. Report any evidence unavailable, especially host smoke, rather than claiming it passed.

## Verified process-level evidence

The `SIGSTOP`/recovery integration test passed on macOS and on the user's Linux server using the real pinned Desktop Commander binary and the repository's ngrok fixture. It verifies the exact owned Desktop Commander PID remains alive and stopped with stdio open; the watchdog reports `desktop_commander` within 40 seconds; the runtime and backend PID are replaced; the old HTTP MCP session fails closed; and a newly authenticated session completes `tools/list`, `read_file`, and the stock `start_process` → `list_sessions` → `read_process_output` flow. It then injects exact-PID SIGKILL faults for Desktop Commander, the fixture ngrok process, and runtime; each reports the expected component, recovers, and accepts a new MCP `tools/list` request. Shutdown verifies the final fixture process tree is gone.

Follow-up review corrections: `/health` now reports `suspect` after one or two failed heartbeat attempts while retaining the three-miss recovery threshold. Startup cleanup bounds `stdio.close()` after connect/initial-ping failure and `local.close()` after HTTP listen failure to 1.5 seconds.

The background supervisor SIGKILL proof found an orphaned ngrok fixture descendant when its runner died. After an IPC disconnect, runtime shutdown now enumerates only members of its private process group and sends bounded TERM/KILL cleanup to those owned children. Normal recovery cleanup remains with the live supervisor. The integration test verifies Desktop Commander, ngrok, and ngrok descendants exit before the same fixture starts and stops again.

The fixture restart-budget proof reaches `terminal_failed` at 5/5, reports that state as unhealthy, then manually starts the same connector after repairing its owned ngrok fixture. The new run is healthy with the counter reset to 0, and an explicit stop removes the runner/runtime/Desktop Commander/ngrok process tree. The supervisor unit test also verifies the consecutive-failure budget resets after the configured stable interval.

Follow-up verification: `npm run build` passed; `npm test` passed with 291 tests, 0 failed/cancelled/todo; targeted SIGSTOP recovery passed in 104.7 seconds; supervisor SIGKILL cleanup and manual restart-budget recovery passed in the process fixture.

The Linux host had no pre-existing DevOS connector, and no production `.env` or ngrok credential was copied there. The host run used an isolated temporary checkout and test ngrok executable, not a public ngrok tunnel. Therefore real public-tunnel registration/recovery on that host remains unverified; fake-ngrok supervisor recovery is covered locally and on the host. The pre-existing local production connector remained `healthy` and owned by its project throughout verification.

Final verification on 2026-10-07: `npm ci` passed; `npm run build` passed on macOS and Linux; `npm test` passed with 285 tests, 0 failures, 0 cancelled, and 0 todo (114 seconds). The focused process-level recovery test passed in 103.7 seconds on macOS and 107.8 seconds on Linux. `git diff --check` passed; `.env` is ignored by `.gitignore` and is not tracked. Final process snapshots found no fixture connector, Desktop Commander, ngrok, runtime, or runner processes and no fixture temp directories. The only remaining local connector processes were the pre-existing project-owned runner PID 72767 and runtime PID 84064 with its Desktop Commander child PID 84072; project state remained `healthy`. No DevOS connector was running on the Linux server before or after the isolated host smoke.

| Fault injection | macOS | Linux host | Evidence |
|---|---|---|---|
| Owned Desktop Commander SIGSTOP with stdio open | PASS | PASS | `desktop_commander` within 40 s; exact child replaced; new MCP session succeeds |
| Desktop Commander SIGKILL / stdio EOF | PASS | PASS | Correct component; old runtime, child, ngrok, and ngrok child exit; new MCP session succeeds |
| ngrok process SIGKILL | PASS (fixture) | PASS (fixture) | `ngrok` component; recovery and new MCP `tools/list` succeed |
| Runtime SIGKILL | PASS | PASS | `runtime` component; recovery, all previous generation PIDs exit, new MCP `tools/list` succeeds |
| `start_process` session and output polling | PASS | PASS | Start returns boundedly; `list_sessions` and `read_process_output` observe the running child; health remains alive |
| Request timeout/cancellation, concurrent calls, shutdown, restart budget | PASS | covered by local suite | Full suite and focused gateway/supervisor tests |
| Live public ngrok tunnel on Linux host | NOT RUN | NOT RUN | No connector or production credential was present; no `.env` was copied |
