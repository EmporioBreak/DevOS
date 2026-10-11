# Feature Specification: Dynamic Agent Runtime

**Issue:** [#246](https://github.com/EmporioBreak/DevOS/issues/246)  
**Status:** Draft — architectural direction approved in conversation; exact privileged execution/cutover requires trusted, version-bound authorization.  
**Compatibility:** Existing live immutable-graph Issues remain on their original, unchanged Runner.

## Problem

DevOS 2 requires the Main Agent to freeze all workers and every possible `worker.on` status transition ahead of execution. Real software-development work discovers unanticipated QA, security, rework and collaboration paths. A fixed graph cannot express them without silently changing its signed contract, blocking work, or unnecessarily waking the Main Agent as a router.

## Product objective

Make agent-directed collaboration the normal execution model: verified agents dynamically choose teammates and exchange task-directed messages; the programmatic broker guarantees isolation, persistence, wake-up and safe external effects. Main Agent continues to own product intent and final acceptance, but does not relay ordinary agent messages.

## Functional requirements

- **FR-01 Task boundaries.** Every runtime belongs to exactly one canonical GitHub repo + Issue, optional linked PR, immutable task policy revision, approved scope and acceptance evidence rules. Cross-task authority is never inferred from the same worker name or shared browser.
- **FR-02 Addresses.** Each agent has a stable task-scoped identity and verified conversation/session binding, a capability+skill manifest, executor kind and current lifecycle status. Main Agent is addressable in the task directory.
- **FR-03 Direct communication.** Any currently authorized teammate may send to any other authorized teammate (developer -> QA, QA -> security, reviewer -> developer, agent -> Main Agent), with no mandatory prime relay and no precomputed route table.
- **FR-04 Dynamic team.** An authorized member may request to introduce an agent at runtime. Broker checks against **preapproved capability, skill, resource and scope policies**; it does not demand predeclared identities or routes. Unknown capability, scope expansion or privilege elevation requires explicit trusted approval, not worker/model assertion.
- **FR-05 Durable messages.** Addressed envelopes include opaque message id, task/run ids, verified sender and recipient, reply/causal id, type, payload, idempotency key and acceptance timestamp. Store before delivery, keep ordered per recipient and acknowledge with durable evidence. Duplicate requests with equal idempotency keys cannot enqueue twice.
- **FR-06 Side-effect proof.** Browser Send and Codex turn launch have separately persisted custody and submission receipts. A may-have-submitted operation must NOT be replayed merely because of timeout/restart. At-least-once transport delivery is not proof of exactly-once provider execution.
- **FR-07 Lifecycle.** Worker idle/sleep/wake reuse the exact task-scoped saved conversation; no replacement when binding is absent/ambiguous. A worker may report evidence or pause while the rest of the team continues. Task finalization is distinct from worker finish.
- **FR-08 Delegated work.** Agents can transfer/request work, attach blocking questions and verification evidence, and perform cycles without spurious `changes_requested` as task completion. Final acceptance/merge/Issue closure stays exclusively Main Agent governed.
- **FR-09 Recovery.** Across restart/SIGKILL/late ACK, restore durable inbox, worker leases, accepted messages and side-effect uncertainty. Never misroute to another task or reissue ambiguous provider messages.
- **FR-10 Budget and observability.** Bound concurrent active worker slots, spawn count, pending queue size, message payload, time, retries, and cost; report waiting/blocked/uncertain states with provenance. Broker delivery policy must not silently change task/product goals.
- **FR-11 Compatibility.** Old approved graph/signed skill manifests and saved sessions retain their legacy executor, browser profile, PR, task state and recovery behavior until independently completed or explicitly approved and safely migrated.

## Non-functional invariants

- Default-deny unverified MCP/chat/caller identity; never derive permissions from prompt-provided worker ids, copied URLs or Issue text.
- Single authorized Camoufox profile/process ownership and task-scoped windows as accepted by their separate delivery gate; no second Production/Staging connector or profile copy.
- Persist before publishing/waking/executing external effects; distinguish accepted command from provider-confirmed user-message send.
- Preserve original Spec Kit/Superpowers sources and signed skill revisions; dynamic admission checks the manifest for each newly created member.
- Reviewer independence and actual functional, security, concurrent/recovery and user-facing E2E evidence remain enforced, even when membership becomes dynamic.
- No silent migration of #214, #224, #226, #232, #239 or ambiguous #226 browser turn.

## Acceptance scenarios

**AS-01 Peer collaboration:** Developer sends directly to QA. QA sends directly to Security. Security directly returns findings to Developer and Reviewer. All have authentic task-local sender, recipient, one Issue/PR and durable delivery evidence; Main Agent need not wake.

**AS-02 Runtime admission:** QA requests previously unplanned Security worker. In-policy capability and budget allow creation with a pinned skill manifest; out-of-policy requests fail closed or require the existing trusted scope-approval path.

**AS-03 Feedback/review:** Reviewer raises verified defects; Developer revises; QA retests; independent Reviewer re-reviews in same Issue/PR/chats. No fixed `worker.on` table. Main Agent alone determines acceptance.

**AS-04 Owner messaging:** A worker may address the original authenticated Main Agent, whose browser turn is woken safely exactly once per accepted message without treating the message as owner approval.

**AS-05 Isolation:** Two Issues each have a worker named `qa`; every message/session/tool grant/PR/receipt stays in its own task, including across shared Camoufox process and restart.

**AS-06 Fault injection:** Kill broker before/after durable enqueue, before/after browser Send and after receipt; recover without duplicate provider Send, duplicate Codex turn or lost accepted message. Ambiguous Send remains fenced pending independent proof.

**AS-07 Legacy:** New-mode task running does not alter any saved or signed existing graph and does not close/replay #239/#226/#224 retained work. Feature flag rollback reverts new-task admission only, without discarding durable state.

## Scope and evidence gates

Implementation shall use TDD and independent reviewer/security checks, a full affected suite and build, plus a signed-in headed browser E2E with actual provider-accepted user-message identity. Unit tests, mocks and shell-driven browser checks do not substitute for a demanded actual browser journey. No merge, deploy or production cutover without exact reviewed Spec Kit/policy SHA, trusted authorization and observed gates.
