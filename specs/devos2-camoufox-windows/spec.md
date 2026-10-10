# Feature: One Camoufox window per DevOS Issue

**Issue:** EmporioBreak/DevOS #226
**Status:** DRAFT; original Spec Kit stage not attested or owner signed

## User scenarios
- Two DevOS Issues execute concurrently in one authorized Camoufox profile; each gets its own visible top-level window.
- Each Issue creates/resumes independent worker conversations in tabs of its own window within the selected ChatGPT Project.
- A task awaiting Main Agent final approval keeps its window and sessions even while other Issues start.
- When Main Agent approves task A, only window A closes; task B and its browser context continue.
- Explicit changes_requested resumes task A in its original window and saved worker conversations.

## Requirements
- FR-001: Exactly one authorized persistent Camoufox process/profile across tasks in the same project; no concurrent launches against one profile.
- FR-002: Stable task ownership keyed by repo and Issue. Each task has exactly one visible top-level window with worker-specific tabs.
- FR-003: Never reuse or navigate another task's browser window, tab, saved worker session, or signed MCP authorization.
- FR-004: Pending turn and send recovery identity include exact task, worker, turn and proof; ambiguous post-submit never replayed.
- FR-005: On verified Main Agent approved, close only that task's tabs/window. Close persistent Camoufox only when no live tasks retain windows.
- FR-006: Preserve task states, browser conversations and authentication across crashes, process restarts, stale locks and mixed task states.
- FR-007: Project-local runtime only; no global daemon, second connector, copies of profile, extra worktree, password disclosure or user-interactive reauthorization.
- FR-008: Existing signed feature #224 and pending #214 remain unchanged; no implementation of Main Agent notification in this Issue.

## Acceptance
- TDD RED and GREEN plus real Camoufox two-Issue two-window E2E.
- Two workers for each Issue share their own window but not another task's.
- Task A final approve cannot close task B or alter its worker chats; changes_requested cannot create a replacement task window.
- Recovery has bounded no-double-send guarantees, exact task/window metadata and no leaking worker grants.
