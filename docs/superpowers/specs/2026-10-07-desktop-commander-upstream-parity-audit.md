# Desktop Commander upstream parity audit

**Baseline:** `main` at `d7626763c0ddd80ee5895c2f9d6a8581c982e0b4`  
**Upstream:** `wonderwhy-er/DesktopCommanderMCP` tag `v0.2.52`  
**Pinned dependency:** `@wonderwhy-er/desktop-commander@0.2.52`  
**Audit date:** 2026-10-07

The comparison uses upstream `src/remote-device/desktop-commander-integration.ts`, `device.ts`, `remote-channel.ts`, `server.ts`, `custom-stdio.ts`, and `index.ts`. The `remote-channel.ts` transport is not part of DevOS's local stdio adapter; it provides context for upstream remote calls, liveness and routing.

## Parity matrix

| Concern | Upstream behavior (`v0.2.52`) | DevOS behavior at baseline | Difference justified? | Action |
|---|---|---|---|---|
| Child launch | Resolves the configured local executable and starts `StdioClientTransport`; supplies `getDefaultEnvironment()`, config overrides and `DC_REMOTE_DEVICE=true`. | Starts the pinned package entry point with `--no-onboarding`, project root as cwd, stderr ignored, and explicit `safeEnvironment(process.env)` plus telemetry disable. | Yes for pinned executable, cwd, onboarding and telemetry controls. Missing remote flag is not justified. | Keep DevOS launch path and safe allowlist; add `DC_REMOTE_DEVICE=true`. Test effective child env. |
| Environment | SDK `getDefaultEnvironment()` allowlists `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` on POSIX. The stdio transport merges that default even when explicit env is supplied. | `safeEnvironment()` explicitly keeps `PATH`, `HOME`, `TMPDIR`, `SystemRoot`, and `LANG`; SDK transport still adds its own default allowlist. Connector credentials are not passed through. | Yes. The explicit allowlist blocks secrets while the SDK restores its standard safe variables. | Preserve the current safety boundary and document the effective merge. Add only the remote flag and deliberate DevOS overrides. |
| Local MCP client identity | `desktop-commander-client`, version `1.0.0`. | `devos-gateway`, version `1`. | No known need; upstream server uses client identity for client-specific behavior. | Match upstream local identity. Keep public DevOS server identity independent. |
| Initialization / readiness | Connects, registers `onclose` and diagnostic `onerror`, then requires successful `listTools()` before setting `ready`. Failed verification discards client and transport. | Connects and requires bounded `ping()` before starting the watchdog and exposing the gateway. Failure cleanup is bounded. | `ping` proves protocol responsiveness, but `listTools()` is the upstream readiness contract and exercises the advertised capability path. | Use bounded `listTools()` for initial readiness, then start the watchdog. Keep periodic `ping()` for liveness. |
| `onclose` | Unexpected close marks adapter not ready and reports one disconnect. Intentional shutdown is suppressed. | `local.onclose` reports `desktop_commander` through a gateway-wide single-shot latch; closing suppresses it. | Yes; DevOS correctly delegates restart ownership to its supervisor. | Preserve behavior and add adapter-level test coverage. |
| `onerror` | Logs diagnostics. It does not mark the child dead because SDK protocol errors can be non-fatal. | Silently ignores the event and does not restart. | Failure policy is correct; diagnostics are missing. | Record safe diagnostics only; never report backend failure from `onerror` alone. |
| Tool forwarding | Calls typed `mcpClient.callTool()` and adds `_meta.remote=true`, preserving supplied metadata. | Routes all requests through generic `local.request()`; `tools/call` currently gets no remote marker. | Generic forwarding is useful for capabilities DevOS explicitly advertises; missing marker is not justified. | Add the remote marker, preserve safe request metadata, and use typed adapter methods for tool calls and discovery. Retain an explicit bounded path for other advertised methods. |
| `tools/list` | Uses typed `listTools()` and returns the upstream tool list. | Generic request, then applies DevOS ChatGPT schema/security adaptation and excludes `track_ui_event`. | Yes; public OAuth/schema shaping and ChatGPT compatibility belong to the gateway. | Keep public adaptation in gateway; source local results through adapter's typed method. |
| `_meta` attribution | Upstream remote caller metadata is passed to the local server; `server.ts` uses `remote` and `clientInfo` to mark remote calls and telemetry. | Public request metadata is forwarded unchanged by generic RPC, but DevOS does not force `remote=true`; the adapter currently receives no explicit metadata policy. | No for the remote marker; arbitrary private metadata must not be blindly copied. | Set `remote: true`; copy only safe, protocol-relevant metadata such as `progressToken` and sanitized `clientInfo`; exclude credentials and gateway internals. |
| Notifications | Upstream integration does not fan local Desktop Commander log notifications out to browser/device sessions. `custom-stdio.ts` turns console output into `notifications/message`. | Local fallback notification handler broadcasts every fallback notification to every authenticated HTTP MCP session. | No. Internal child logs are not requester-scoped and must not become session-wide traffic. | Suppress internal log notifications; count them safely. Route only request-correlated progress to the originating HTTP request. |
| Progress | `callTool()` accepts request metadata; remote channel owns the upstream delivery path. | MCP request progress callback receives progress for a local request and sends it to the matching public request's `extra.sendNotification`, preserving its token. | Yes; this is an appropriate HTTP-gateway extension. | Preserve exact requester-scoped routing; cover two simultaneous sessions and notification flood. |
| Cancellation | Upstream remote protocol does not define DevOS's HTTP request cancellation bridge. | Each public request gets its own `AbortController`, linked to that session request; request-local timeout/cancel does not call backend failure. | Yes; required by public HTTP transport. | Preserve; test cancellation of A leaves B and watchdog healthy. |
| Request deadlines | No equivalent public HTTP deadline in local adapter; process tools return session/PID for later polling. | Service calls have a 60-second cap; `tools/call` has a 60-second idle timeout reset by progress and 180-second absolute cap. | Yes; external-client boundary requirement. | Preserve all bounds; document process/session handoff and ensure request timeout remains request-local. |
| Concurrent calls | SDK client multiplexes calls; upstream wrapper does not serialize them. | Generic SDK requests are concurrent; tests already cover concurrent calls and list requests. | No difference required. | Preserve independent request tracking while extracting adapter. Add metadata and cancellation isolation assertions. |
| Stale / dead child | `onclose` clears readiness; `ensureReady()` can lazily reinitialize with a bounded restart backoff. | `onclose` and the independent single-flight watchdog signal `desktop_commander`; DevOS supervisor replaces the full runtime/process group. | Yes. A second adapter restart loop would conflict with process ownership and the single restart budget. | Keep supervisor as the sole respawn owner. Do not copy upstream `ensureReady()` loop. |
| Hung-but-alive child | Upstream stdio integration has no independent heartbeat for a child that remains alive but stops answering. | Watchdog performs bounded `ping()` every 15 seconds, single-flight, and reports after three misses. | DevOS-only extension is justified by the production SIGSTOP reproduction. | Keep watchdog adjacent to the adapter; retain 15s / 5s / 3-miss semantics and real SIGSTOP recovery proof. |
| Failed initialization cleanup | `discardChild()` clears state then closes client and transport. Its close calls are not themselves bounded. | Connect and initial-ping failures bound stdio close; HTTP listen failure bounds local close. | DevOS is already stricter and bounded. | Keep shared bounded cleanup for all adapter startup failure and shutdown paths; no half-built process. |
| Shutdown | Marks shutdown first, closes client and transport with timeouts, clears references; suppresses intentional disconnect. | Gateway marks closing, stops watchdog, aborts requests, settles HTTP sessions/server and boundedly closes client. Runtime then owns process-group cleanup. | Yes; the gateway also owns public HTTP/OAuth sessions. | Move local close into adapter, maintain bounded idempotent close and runtime escalation. |
| Restart / reinitialize | Local adapter can lazily respawn after failure. | Supervisor replaces runtime, gateway, Desktop Commander and owned ngrok generation together; restart budget is centralized. | Yes; single owner gives one budget and one generation boundary. | Preserve full-runtime restart and do not replay ambiguous calls. |
| Resources / prompts / ping | Upstream device invokes local Desktop Commander tool calls and tool discovery; local adapter's typed calls are tools-focused. | Gateway advertises local capabilities and generic fallback forwarding can handle request methods beyond tools. | Partly. Existing advertised public capabilities must remain functional. | Route `tools/list`, `tools/call`, and `ping` through typed adapter methods; keep explicit bounded forwarding for other currently advertised request methods. |
| Diagnostics | Upstream logs messages and captures remote diagnostics; it does not expose DevOS process ownership metrics. | Existing connector diagnostics capture supervisor/runtime state; gateway has no bounded request lifecycle ring buffer or notification counts. | DevOS-specific observability is justified, but payloads must remain private. | Add bounded payload-free counters and recent request lifecycle metadata; include PID/start time/RSS/CPU only in private diagnostics where available. |

## Decisions

1. Extract a `DesktopCommanderIntegration` that owns one stock local MCP client and stdio transport, readiness, typed discovery/tool/ping methods, disconnect semantics, watchdog, diagnostics counters and bounded close.
2. Keep HTTP, OAuth, public sessions, public request deadlines and HTTP progress delivery in `connector-gateway.ts`.
3. Preserve `DC_REMOTE_DEVICE=true`, `desktop-commander-client` / `1.0.0`, and `_meta.remote=true` to match upstream behavior.
4. Keep the DevOS supervisor as the only restart owner. Do not copy upstream's child respawn/backoff into the runtime.
5. Suppress child `notifications/message` and unrelated protocol notifications at the public boundary. Only the MCP request's progress callback may notify its originating HTTP request.
6. Keep the pinned stock dependency at `0.2.52` unless a reproducible test demonstrates an upstream defect that requires a version change.

## Verification baseline and limits

- `npm ci`: passed on the isolated worktree; package lock unchanged. npm reported 11 existing audit findings (6 moderate, 5 high); dependency remediation is outside this parity task unless evidence requires a dependency change.
- `git check-ignore -v .env`: `.env` is ignored by `.gitignore:4`.
- `git ls-files .env`: no tracked `.env` path.
- The existing production connector remains in the primary checkout. Fault injection for this task must use exact process ownership and an isolated fixture; do not disturb that connector for ordinary-load tests.
- Public production ngrok and host-level SIGSTOP proof are final acceptance checks and must be reported separately from fixture coverage.

## Implementation results and final evidence

The adapter extraction and verification are implemented on `codex/desktop-commander-upstream-parity`, based on the requested `main` SHA `d7626763c0ddd80ee5895c2f9d6a8581c982e0b4`.

| Concern | Final DevOS behavior | Evidence / disposition |
|---|---|---|
| Child launch and client identity | Stock pinned package; SDK-safe environment plus DevOS allowlist/overrides; `DC_REMOTE_DEVICE=true`; local identity `desktop-commander-client` / `1.0.0`. | Adapter environment and identity tests pass. No package upgrade or upstream patch was needed. |
| Readiness and liveness | Bounded `tools/list` proves readiness; only then does the single-flight 15s/5s/3-miss watchdog start. Health exposes `unknown`, `alive`, `suspect`, or `stale/dead`. | Adapter and watchdog unit tests pass. Normal-load stress and the process integration test do not trigger a restart. |
| Request metadata | `tools/call` enforces `_meta.remote=true`, forwarding only a valid progress token and bounded client name/version. | Metadata allowlist test passes, including exclusion of arbitrary metadata and secrets. |
| Notifications and cancellation | Internal notifications are counted locally and never broadcast. Progress is forwarded only to its originating public request; abort/timeout is request-local. | 1,000-message two-session isolation test passes; cancellation is followed by a successful call. |
| Deadlines and process sessions | Service requests cap at 60s; tool calls use 60s idle reset by progress and 180s total. Long process work returns a PID/session for later polling. | Deadline/progress/cancel tests and start/poll integration cycles pass. |
| Diagnostics and cleanup | Payload-free bounded history (50 lifecycle events), notification counters and exact owned-PID usage are recorded. Startup/shutdown closes are bounded; intentional close cannot report a late failure. | Diagnostics allowlist/file-bound tests; bounded startup/close tests; shutdown race assertion pass. |
| Recovery and ownership | DevOS supervisor remains the only restart owner and replaces the runtime generation. | Fixture integration passes supervisor death, exact-child `SIGSTOP`, `SIGKILL` of child/ngrok/runtime, stale-session rejection, fresh MCP calls after recovery, and owned-child cleanup. The test also passes 100 public `tools/list` plus 100 `get_config` calls and 20 concurrent reads. |

### Final commands and host checks

- `npm ci`: passed; lockfile unchanged. npm reports 11 audit findings (6 moderate, 5 high); no dependency update was justified by a demonstrated upstream defect.
- `npm run build`: passed after the final test changes.
- `npm test`: 301 passed, 0 failed; includes the real local pinned Desktop Commander process integration, diagnostic-only `onerror` proof, and controlled fixture fault injection.
- `tests/desktop-commander-stress.test.ts`: 100 `tools/list` + 100 `get_config`, 20 concurrent config reads, three short process start/poll cycles, healthy watchdog, bounded payload-free history, and exact child cleanup passed.
- `SIGSTOP` integration: passed in 106.7 seconds. Three-miss detection remained within the test's 40-second bound; supervisor replaced runtime and Desktop Commander PIDs; old session failed closed; a newly initialized MCP session successfully called tools after recovery. Subsequent child, ngrok, runtime and supervisor death paths recovered and cleaned their owned processes.
- Local real-package smoke: public-path integration covers OAuth, `tools/list`, `read_file`, `start_process`, `list_sessions`, and `read_process_output` after replacement.
- The first direct MCP plugin smoke returned `MCP -32603 Internal error`. After the user explicitly asked to restart MCP, the primary checkout connector was stopped and started through `./devos connector stop` / `./devos connector start`; status reported `healthy`, restart budget `0/5`, and a fresh MCP `get_config` call succeeded. This confirms the existing primary-checkout connector, not deployment of this feature branch.
- A controlled kill/recovery of the already-running production public ngrok tunnel was not performed. The recovery suite uses an isolated ngrok fixture, and production fault injection would require deploying/running this branch against the live connector. Do not claim public-production ngrok recovery from fixture evidence.
- `.env` remains ignored and untracked; no `.env` was copied into the worktree. No GitHub Actions, Keychain, global daemon, process-name cleanup, or dependency patch was added.

### Remaining limitation

Public recovery for a real ngrok tunnel on this feature branch remains unproven. Its isolated live tunnel attempt failed before HTTPS registration and consumed the isolated supervisor's 5/5 restart budget. The existing primary connector was left healthy and its new MCP request succeeded after restart, but it runs the primary checkout rather than this feature branch. The local real Desktop Commander and complete fixture fault-recovery evidence are green; keep this branch-specific limitation explicit.

## Upstream source references

- [`desktop-commander-integration.ts` at v0.2.52](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/v0.2.52/src/remote-device/desktop-commander-integration.ts)
- [`device.ts` at v0.2.52](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/v0.2.52/src/remote-device/device.ts)
- [`remote-channel.ts` at v0.2.52](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/v0.2.52/src/remote-device/remote-channel.ts)
- [`server.ts` at v0.2.52](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/v0.2.52/src/server.ts)
- [`custom-stdio.ts` at v0.2.52](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/v0.2.52/src/custom-stdio.ts)
- [`index.ts` at v0.2.52](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/v0.2.52/src/index.ts)
