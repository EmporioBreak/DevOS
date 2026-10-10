# Implementation Plan: task windows with shared Camoufox

**Issue:** #226
**Status:** DRAFT; original speckit plan stage not yet attested

## Technical design
1. Create a single project/profile-owned persistent runtime. It owns one BrowserContext/real Camoufox process and tracks multiple task windows.
2. Keep task-specific worker turn routing, saved conversation IDs and signed MCP grant identity isolated by repo/Issue/worker/turn.
3. Per task, create or recover one top-level window (Firefox context.newPage opens a window); open all sibling worker tabs through window.open from that Issue's owned first page.
4. Persist minimal exact task window identity/leases and active task status without storing OAuth or exposing ChatGPT URLs in GitHub.
5. Make task close explicit and scoped; task-owned pages close only on verified approved, and the shared persistent process closes only after all task leases are released.
6. Maintain bounded restart/lock recovery without guessing page identities, replaying a possible sent prompt, or killing other tasks' browser windows.

## Isolation and safety
- The existing chat-worker-observer MCP authorization proof remains mandatory; do not remove or weaken it.
- Use a project-local owned runtime and Unix socket with actual process identity proof and permission checks.
- Never create a second Production/Staging MCP or a second persistent profile to avoid collision.
- Preserve original #214 and #224 saved worker sessions and signed task states.
- The original pinned github/spec-kit stages, TDD and independent review remain required.

## Verification plan
- Unit tests: task window ownership, concurrent start, stable tab assignment, per-task shutdown, mixed stale metadata and incomplete send.
- Integration: shared profile dispatches two Issues without a second Camoufox launch; independent task report proofs and sessions.
- Real browser E2E: two visible task windows in one Camoufox, own worker tabs, correct ChatGPT Project URLs; close only approved Issue.
- Run TypeScript build and full relevant test suite; publish real evidence in the same PR.

## Scope boundary
Only fix runtime/profile/window lifecycle. No Main Agent wake-up implementation, no unrelated QA #214 acceptance, and no production deployment before real final review.
