# Implementation Plan: Dynamic Agent Runtime

**Issue:** #246 | **Stage:** Draft planning only | **Base:** DevOS main  
**Sources:** DevOS `src/workflow.ts`, `src/orchestrator.ts`, `src/workflow-loader.ts`, `src/runner-skill-graph.ts`, `src/chatgpt-browser-executor.ts`, `src/codex-executor.ts` and CoS `src/main/agents.ts`, `docs/tool-surface.md`. Pin reviewed CoS revision and retain its MIT attribution for any copied code.

## Design principles

The Main Agent defines a **host-sealed task policy**, not an immutable execution itinerary or a per-task user-consent receipt. A trusted task-scoped broker validates and durably applies **agent decisions**, and a task runtime executes authorized activities. A worker-directed message can target any member; a worker-directed spawn can request a new member inside approved resource/capability bounds. Browser/Codex transport adapters do not own approval or select recipient.

### Layer boundaries

1. **TaskPolicy / AgentAdmission:** task-scoped authorization, immutable policy-revision hash, capability and skill eligibility, maximum slots/resources, scopes requiring trusted approval, independent verification coverage.
2. **AgentDirectory / TaskRuntime:** stable task + agent identities, verified executor/session/chat binding, lifecycle and supervised concurrent execution.
3. **Broker / durable journal:** typed messages and handoffs, atomic acceptance, inbox/outbox, wake/ACK, idempotent dedupe and SIGKILL/recovery fences.
4. **Transports:** existing browser-worker Send with one true provider receipt path, local Codex turn execution with saved sessions, Main Agent authenticated wake-up. Match their already approved, separately evolving APIs; do not implement a second sender.
5. **EvidenceGate / Finalization:** map original acceptance criteria to observed verification evidence, independent review, Main Agent final decision, existing GitHub merge/closure rules.

## Compatibility

Define a discriminated runtime selector: `legacy_workflow_v1` retains signed `start/workers/on` and `currentWorkerId`; `dynamic_agents_v2` uses a task-specific event journal and agent policy. No automatic state upgrade for in-flight Issues. Admission chooses mode per newly authorized task. Never open two runtimes for the same repo/Issue simultaneously.

## Protocol sketch (to refine before code)

- `agent.request_spawn`: verified caller, requested skill/capability and scope; admission returns allocated task-scoped id or policy rejection.
- `agent.send`: verified sender and recipient, message-id, correlation, type (work/question/evidence/review/blocker), payload.
- `agent.status`: scoped directory/queue/leases; no unrelated task metadata.
- `agent.finish_work`: end current work unit, publish evidence and release slot; do not implicitly end task.
- `task.request_final_review`: require acceptance evidence and independent review; Main Agent makes final decision.

All acceptance is authoritative only after durable commit; browser/provider evidence requires a separate state transition. Fail closed if caller identity or provider outcome is ambiguous. Avoid unbounded heartbeats/polling.

## Implementation stages

**Stage A — contract/test vectors (no Production side effects).** Capture existing active ledger and baseline; unit-test dynamic message graph semantics against current static graph. Define policy JSON schema, message envelope, explicit state transitions and compatibility selector.

**Stage B — broker/core.** Implement isolated state machines and atomic storage; TDD for direct worker messaging, dynamic admission, queue limits, reentrancy, backpressure, dedupe, crash recovery and cross-Issue noninterference.

**Stage C — adapters.** Integrate existing runner executor interfaces and signed worker reports; CoS-inspired wake/finish semantics. Do not replace original browser send custody or override #239/#224/#226 ownership. Ensure role/skills and authorization from verified session identity.

**Stage D — orchestration/evidence.** Enable dynamic QA/reviewer/security work routing, independent reviewer results and Main Agent addressable messages, without graph predeclaring branches. Attach acceptance evidence to task and maintain original GitHub Issue/PR lifecycle.

**Stage E — real E2E and release.** Run actual headed signed-in browser two-Issue journeys, worker-to-worker and Main Agent messages, stress/fault injections, independent code and security reviews, full tests, rollback drill. Owner authorizes Production cutover and any privileged scope expansion; routine task admission inside a host-sealed policy does not require separate evidence that a user explicitly initiated it. Existing legacy tasks remain on legacy path until separately proven.

## Migration/rollback matrix

| State | Rule |
|---|---|
| New, authorized Issue with v2 policy | Admit dynamic runtime under explicit feature flag |
| Existing Issue with v1 saved graph | Continue exact signed v1 graph; never auto-upgrade |
| Active Camoufox/profile/browser task | Reuse existing provider custody only; never duplicate process or Send |
| Unknown/contradictory session identity | Block; do not recover by replacing conversation |
| Uncertain provider Send/ACK | Fence and await independent receipt/proof; never blindly replay |
| New runtime defect | Stop admitting v2, retain journal and sessions for recovery; v1 untouched |
| Release finalization | Main Agent verifies evidence, merges exact PR, closes Issue only when actually complete |

## Proposed verification responsibilities

- Implementation: local Codex with specific source capabilities and test execution, after approved exact task policy.
- Independent code/reliability reviewer: verify dispatch, transactional acceptance and isolation, not implementation author.
- Security auditor: inspect trust boundaries, runtime admission, MCP session binding and replay/authority escalation.
- Actual browser E2E operator with proved headed access: observe real provider messages, task tabs/windows and Main Agent wake. If unavailable, acceptance stays blocked, not substituted with mocks.
- Main Agent: final product acceptance, merge and GitHub Issue closure only after gates.

These are **evidence responsibilities, not predeclared immutable worker routes**. Worker identity and membership may be selected dynamically inside an approved policy. Scope elevation needs explicit trusted owner approval.

## Decisions pending trusted exact-artefact approval

Final bounds for concurrent workers, maximum dynamic membership, allowed executor/capability classes, message retention and rejection of out-of-policy admission; choose persistence journal schema with measured crash tests. No production execution or mutation of legacy task graphs prior to approval.
