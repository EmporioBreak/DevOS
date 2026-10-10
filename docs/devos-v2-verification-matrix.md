# DevOS 2 — V01 automated acceptance matrix (#149)

This branch is **isolated staging work** for [Epic #121](https://github.com/EmporioBreak/DevOS/issues/121). It deliberately does not use DevOS Runner to implement the migration, restart production MCP, merge PRs or approve the owner's final release.

## Contract / source of truth

The machine-readable [acceptance matrix](../config/devos-v2-acceptance-matrix.json) maps **47** distinct product/regression criteria to one of two honest states:

- **36 `automated`**: the exact *enabled* test name in an existing `tests/*.test.ts` file and its working staged implementation. The checker verifies filenames, actual `test(...)` declarations and that the reference is not a skipped/todo/only test. A mapping alone is **not** execution proof; the actual build and test command results are recorded in the relevant PR.
- **11 `live_pending`**: actual ChatGPT/GitHub/macOS/E2E/owner-release obligations which a deterministic fixture cannot certify. Every row has a concrete linked Issue (#150–154) and a check. The checker explicitly refuses to replace one with a fabricated `automated` result.

Important categories covered by the automated map: trusted Main Agent scope/plan gates; original Spec Kit single feature workflow and Constitution; append-only Converge; real local Bugfix RED/GREEN reproducer and scope; original Assess with sourced recommendation without code; immutable worker graph and browser-first Codex fallback; exact signed skill versions and selection policy `required/optional/off`; default-deny chat, worker grants and MCP native authorization widget; session and request no-replay; genuine Codex JSONL process lifecycle; local sanitized pipeline timeline; final Main Agent-only acceptance; backward-compatible workflow schema; multi-Issue synthetic graph stress; optional original Git extension.

## Automated verification commands

```sh
npm run build
npx tsx --test tests/acceptance-matrix.test.ts
npm test
```

`npm test` runs the repository's `tsx --test --test-concurrency=1 tests/**/*.test.ts` test suites. It uses isolated temporary directories, fixture OAuth servers/loopback gateways, fake browser worker reports where specified, and never triggers the external Production ngrok service. New regression suites for Bugfix, Assess, Runner strict graph, Main Agent final review, pipeline diagnostics and the acceptance matrix must all be in this test enumeration. Report **pass/fail/skipped counts**, not merely an exit code, before claiming suite PASS.

Opt-in **real host-local** Camoufox lifecycle smoke from #146 and the read-only Production/Staging port-isolation probe from #145 are separately verified where noted; neither proves an actual connected ChatGPT Web/iPhone plugin:
```sh
npx tsx tests/shared-browser-runtime.smoke.ts
node scripts/staging-isolation-smoke.mjs
```

## Open E2E/release obligations — not verified by this PR

| Trace | Issue | Acceptance requires |
| --- | --- | --- |
| Real GitHub Epic/Issue graph and feature / bugfix / assess original commands | #150 | Actual saved browser Project worker conversations, canonical original skill invocations, worktree code and real linked Issues/PRs |
| Actual reviewer→rework→Main Agent and browser→Codex fallback | #150 | Independent review with real ChatGPT/Codex sessions, correct owner judgment, same PR and worker graph |
| Staging MCP plugin on ChatGPT Web and iPhone | #151 | Real OAuth/client consent, inline App widget/Safari fallback, no double approval form, no contamination of other chats |
| Remote Cloudflare Staging vs ngrok Production | #151 | Confirm distinct real externally connected OAuth resource, separate state and untouched production |
| Actual failure/restart/stress and privilege isolation | #152 | Host-level disconnects/replay/grant expiry with cleanup, without touching Production processes |
| README/AGENTS and tutorials | #153 | New agent can reproduce feature/bugfix/assess flows using correct released commands |
| Release, rollback, owner acceptance | #154 | Explicit post-E2E release decision, backups, reversible migration and verified Production smoke; no silent promotion |

The JSON intentionally retains all these as `live_pending`. **Do not close Epic #121, approve V01 completely, merge or deploy Production while the real live release blockers remain open.**

The synthetic host/GitHub verifier callbacks in tests are *not* real user authorization or independent review. All upstream pins are SHA-locked and must be checked against the existing repository provenance, not downloaded opportunistically during tests.
