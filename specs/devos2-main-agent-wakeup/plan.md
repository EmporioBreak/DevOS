# Implementation Plan: Main Agent wake-up from Runner
**Issue:** #224
**Status:** DRAFT — original `speckit.plan` stage not attested; owner SHA-bound approval outstanding

## Architecture
The signed task/worker graph and `ChatAccessRegistry` are the security boundary. Bind an Issue's initiating Main Agent through independently verified MCP session identity to its exact MAC-protected stored owner URL. Never resolve owner by choosing the sole or first registry entry. Private `/c/` and `/share/` are both supported as input references; navigate in the authenticated existing Camoufox profile and verify that the final destination is the expected editable original conversation. The public shared snapshot itself is never a writable destination.

On every new `final_review_required` transition, atomically create a durable notification record keyed by task, main-agent binding and review round. Dispatch through Camoufox only after a bounded idle/identity check; distinguish proven pre-submit error from may-have-submitted, persist submission intent before Send, and make recovery read-only after uncertainty. Notification does not authorize any Main Agent decision. Existing owner approval remains the authenticated terminal decision.

## Scope
- Expected implementation candidates: `src/chat-access.ts`, `src/orchestrator.ts`, `src/cli.ts`, task-scoped Camoufox/shared-browser runtime, new focused delivery module and tests, docs.
- Preserve `devos_worker_report` as worker terminal status and `chat-worker-observer` as independent MCP-auth proof. Owner wake-up is not a replacement for either.
- No production deployment or merge before independent review and Main Agent handoff.
- Work in the sole local Production checkout with a normal Git branch; do not create additional worktrees or duplicate browser profiles.
