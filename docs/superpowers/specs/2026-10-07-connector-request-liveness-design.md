# Connector Request Liveness Design

## Goal

Make the DevOS MCP connector distinguish an unresponsive Desktop Commander backend from a slow, timed-out, or cancelled individual request. Preserve the existing supervisor, process ownership, restart budget, OAuth state, and stock `@wonderwhy-er/desktop-commander` integration.

Baseline: `80c50a79a14e19df3f01f613f77d57a04a23a8d3` (`main` and `origin/main` matched during discovery).

## Current behavior

`src/connector-gateway.ts` owns one MCP `Client` over `StdioClientTransport`. Its `onclose` callback reports `desktop_commander` failure, but no independent backend liveness request exists. The HTTP `/health` currently reports only whether the OAuth provider is configured. Requests are forwarded with the inbound MCP `AbortSignal`, but no gateway-specific idle or absolute deadline is set. `gateway.close()` closes HTTP sessions and the MCP client without its own deadline; the runtime/runner provide process-group cleanup.

The pinned MCP SDK 1.32.1 exposes `Client.ping()` and request options for `signal`, `timeout`, `resetTimeoutOnProgress`, and `maxTotalTimeout`. The pinned Desktop Commander is 0.2.52. Its upstream repro labels `maxProcessWaitMs` as a desired behavior that current code does not meet, so an upgrade cannot be assumed to fix long-running calls.

## Design

### Backend liveness

- Start one watchdog after local MCP initialization; it runs independently of HTTP requests.
- Send standard MCP `ping` on the existing local Client every 15 seconds, with a 5-second timeout.
- Count consecutive failed or timed-out pings; reset the count on success. Three consecutive misses report `onFailure("desktop_commander")` once. A single missed ping does not restart the runtime.
- Stop the watchdog before beginning gateway shutdown. Ignore late ping completions after close.
- Store `lastBackendOkAt` and a backend-alive flag from watchdog results. `/health` reports gateway/provider readiness separately from backend liveness and the last successful backend check. The public response contains no PID, command line, secret, or internal path. A stale result makes backend liveness false.

### Request lifecycle

- Keep the inbound cancellation signal connected to the corresponding forwarded local request. Cancellation and request timeout are request-local and do not call `onFailure`.
- Bound service requests such as `ping`, `tools/list`, and discovery/readiness operations to at most 60 seconds.
- For `tools/call`, use a finite idle timeout with progress resetting that idle timeout and an absolute maximum of 5 minutes. This gives long calls time to report progress without allowing an endless RPC. Do not transform a timeout into a backend failure; independent pings decide backend health.
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
| Owned Desktop Commander receives SIGSTOP | ≤ interval + 3 × timeout + scheduling margin | desktop_commander | yes | new MCP request succeeds; old owned PID is gone |
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

## Constraints and exclusions

- Keep `.env` as the secret source; ensure it remains ignored and untracked.
- No GitHub Actions/CI, Keychain, new secret store, global daemon, global process-name cleanup, infinite retry, or unbounded await.
- Do not fork or reimplement Desktop Commander terminal/process sessions.
- Do not mix in browser migration or unrelated connector cleanup.

## Acceptance evidence

Implementation is complete only after `npm ci`, `npm run build`, and full `npm test` pass; targeted gateway/supervisor/lifecycle/cancellation/concurrency/shutdown/ownership checks pass; connector smoke includes owned-process SIGSTOP recovery and post-recovery MCP request; process snapshots show no connector/DC/ngrok/runtime/runner or fixture orphans; and `.env` is ignored and untracked. Report any evidence unavailable, especially host smoke, rather than claiming it passed.
