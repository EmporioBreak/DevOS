# AGENTS.md

## Purpose

This repository is operated through DevOS. New local Codex sessions should treat this file as the standing operational contract for work in `EmporioBreak/DevOS`.

The main agent owns the user task and final judgment. DevOS owns coordination, never judgment.

## Working model

- GitHub Issue and linked PR are the source of truth for the task.
- Keep one task-scoped worker graph per Issue. Do not invent new workers, roles, routes, or lifecycle stages during execution.
- Browser workers are normal workers. Local Codex is used for host-local work and for the main-agent role when DevOS returns final review to the local caller.
- Final task acceptance is not a worker role. The main agent decides `approved` or `changes_requested`.
- If the main agent requests changes, continue the same task and preserve task-scoped worker sessions and the existing PR.

## Canonical statuses

Use the same status names everywhere: protocol, routing, orchestration, tests, documentation, and terminal output.

Worker result statuses:

```text
done
approved
changes_requested
needs_local_worker
failed
```

Task lifecycle statuses:

```text
ready
running
final_review_required
changes_requested
completed
blocked
failed
```

Do not reintroduce `needs_host` or create alternative human-readable aliases for canonical statuses.

## Main-agent handoff

When DevOS returns:

```text
DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED", ...}
```

the main agent must:

1. inspect the actual Issue, PR, current head, diff, latest worker reports, and relevant verification;
2. decide the task against the original product requirements;
3. return `approved` only when the task is actually complete;
4. otherwise return `changes_requested` and continue the same task.

Do not substitute an internal acceptance worker for this decision.

## Browser session invariants

These are product invariants:

```text
same task + same worker => same saved browser conversation
new task + browser worker => fresh conversation
fresh browser conversation => inside the configured ChatGPT Project
```

Do not silently create a standalone ChatGPT conversation when a project is configured. Do not silently replace a missing same-task session with a new conversation. Treat invariant violations as defects that need diagnosis.

## Local-work rules

- Prefer browser workers for normal repository implementation/review when the declared graph routes there.
- Use local Codex when `needs_local_worker` is returned or when host-local reproduction/verification is genuinely required.
- Do not claim local verification that was not actually run.
- Keep changes minimal and scoped to the active task.
- Do not mix unrelated browser reliability work, lifecycle changes, or cleanup into a focused task.

## Repository and execution rules

- DevOS is project-local and one-shot.
- No daemon, watcher, polling loop, background service, or global install.
- Avoid GitHub Actions for the inner development loop unless a task explicitly requires them.
- Do not create throwaway repositories for smoke tests unless there is a concrete need and explicit approval.
- Preserve intentional `run` / `restart` semantics.
- README is user-facing and should remain concise.

## Change discipline

Small, obvious repository maintenance does not need a new DevOS Issue or worker graph when the main agent can safely perform it directly. Use a normal small PR when appropriate.

For substantive product behavior, use the Issue/PR workflow and keep the task contract explicit.
