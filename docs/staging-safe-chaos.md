# DevOS 2 — safe Staging chaos/failure test gate (#152)

Date: 2026-10-09. This is a **non-destructive Mac-host and synthetic worker chaos** checkpoint, not the complete live Web/iPhone or Production release fault-injection gate.

## Actually executed

```sh
npm run build
npx tsx scripts/staging-safe-chaos.smoke.ts
```

Results observed from actual local processes:

| Check | Evidence | Result |
| --- | --- | --- |
| Build | TypeScript production compilation | PASS |
| Cross-component safety suite | Browser chaos (32 independent Issues, six turns each), signed worker grant spoofing/expiry, ambiguous browser turn recovery, shared browser runtime, OAuth refresh crash fixture, Codex JSONL completion, diagnostic integrity | **73/73 PASS**, zero failed/skipped/cancelled |
| Real host Camoufox smoke | New temporary task-owned + control browser, controller disconnect/reconnect, owned-only graceful/fallback cleanup | PASS |
| Production listener integrity | Read-only PID of :8787 listener and health before and after stress | **Same PID, health 200** |
| Staging listener integrity | Read-only PID of :8788 listener and health before and after stress | **Same PID, health 200** |
| Restart / owner credential mutations | No script command restarts a connector, edits live OAuth state or touches Production profile | None requested |

The script emits only aggregate diagnostic flags, never OAuth secrets, raw ChatGPT session URLs, test prompts or tunnel hostnames. Its fixture cases are **synthetic** (except the real temporary owned-browser smoke). A matching listener PID proves the current process was not restarted, but does **not** establish that every possible Production config/state byte is unchanged; no claim of exhaustive state audit is made.

The script deliberately avoids destructive failure injection into the actual running Production service. Temporary fixture OAuth processes and Camoufox contexts live outside both live profiles; it checks that the unrelated control browser survives the task-owned cleanup.

## Remaining real fault/compatibility verification

Before #152 or Epic #121 can be approved, actual #150/#151 need to pass and then verify:

- Live authorized Staging ChatGPT plugin Web and iPhone with replay-safe recovery across real disconnect/crash, no duplicate side-effectful tool call
- Real current worker grant expiry/revocation, forged chat/client/role attempts against the Staging plugin, and negative Mac tool-read/write check
- Non-destructive staged failure/restart with original worker's exact saved Project URL and same linked Issue/PR
- Bounded retry/timeout and realistic measured startup/per-turn metrics under current Cloudflare transport
- Actual clean staging-owned cleanup without closing unrelated user/Production browser; record evidence with Issue and safe links

**Important:** #150's first real ChatGPT Project QA turn timed out without a verified terminal result; it may have submitted, so its one-shot guard remains in force. Do not replay it to manufacture success. The full Staging plugin UI acceptance in #151 remains pending. No Production promotion before #154.
