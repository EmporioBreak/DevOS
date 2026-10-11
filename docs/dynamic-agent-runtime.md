# DevOS dynamic agent runtime: implementation status and safety contract

Issue #246 / Draft PR #247. Experimental library code only. It is not a Production replacement for the currently approved legacy Runner. No current task is silently migrated.

## Present on this branch

- `src/dynamic-agent-runtime.ts`: policy-scoped agent directory, direct peer and Main Agent addressing, dynamically admitted agents, session identity binding, idempotent per-recipient queue, synchronous durable acceptance, cross-task protection, owner-only final decision and claim-before-provider-send fence.
- `src/dynamic-agent-scheduler.ts`: bounded, on-demand, graph-free queue-drain pass; other agents progress even when one recipient has an ambiguous send. It requires authentic recipient sessions and does not poll indefinitely.
- `src/dynamic-agent-dispatch.ts`: narrow host-verified dispatch seam requiring existing exact saved recipient session and an independently checked provider-receipt callback. It deliberately does not synthesize ChatGPT user-message IDs, create new browser contexts, close task windows or auto-retry ambiguous sends.
- Dedicated tests for peer-to-peer routing, dynamic QA/security, frozen session binding, admission and policy denial, task isolation, ordered delivery, crash/ambiguous replay barriers, host transport and final Main Agent judgment.

## Host verification requirements (not implemented by this library)

A production caller must wire `DynamicTrustBoundary` to actual trusted gateway facts rather than model-authored fields:

- `resolveCaller`: authenticated MCP session / exact saved ChatGPT or Codex identity and task owner.
- `verifyPolicy`: owner-authorized exact policy + scope and pinned skill manifests (not merely a string looking like a SHA256).
- `verifyNewAgentBinding`: verifies the newly created worker's actual session and task ownership. A worker's requested fingerprint is not proof.
- `verifyTransportLease`: host-owned lease on this exact task, agent and message, no role impersonation.
- `verifyProviderReceipt`: real provider-accepted outgoing user-message or execution identity and task/turn correlation.
- `verifyNoSubmit`: independently proven pre-submit failure, not a timeout or model statement.

If any evidence is missing/ambiguous, the integration must reject or fence the operation. A `dispatch_uncertain` message must never be re-sent just because the original command timed out or a process restarted.

## Persistence and recovery

The new store lives at `.devos/dynamic/<encoded-repo>-issue-<issue>.json` and never reads or writes `.devos/state` or frozen graphs. Single-writer persistence uses exclusive lock creation, a fully synced temporary file, atomic rename and directory fsync. A writer killed while holding its lock leaves an explicit fail-closed `.lock`; removing it requires independently verifying the writer is dead. This still needs a proper automated fenced recovery design before Production cutover.

## Known unfinished integration / gates

1. Wire the new runtime through a separately versioned CLI and MCP tool surface; existing `Workflow(version:1)` and `Orchestrator` remain unchanged.
2. Connect actual ChatGPT Camoufox worker identities, conversation wake/turn, provider receipts and original owner conversation, **after** #239/#224/#226 browser shared-custody gates are independently resolved.
3. Connect local Codex skill manifests and exactly one launch/receipt identity; test resumes without duplicate external commands.
4. Enforce real independent reviewer evidence gates and finish/merge controls at the Main Agent boundary.
5. Replace permanent crash lock with a provably fenced automatic process-exit recovery; add multi-process SIGKILL tests and realistic queue backpressure/retention tests.
6. Run full DevOS build/test suite, independently review code/security and execute a signed-in real provider E2E on authorized disposable Issues. The local isolated TypeScript tests on this draft do **not** establish any of those gates.
7. Seek exact reviewed owner authorization and explicit staged rollout; v1 signed tasks must remain on their original executor until separately completed or safely migrated.

### Local isolated verification

Compiled the new modules with TypeScript strict NodeNext settings, Node 22 and appropriate Node type declarations; 13 `node:test` cases pass with mocked trust/transport providers. This verification does not include the full repository dependency graph or any live browser/provider service.
