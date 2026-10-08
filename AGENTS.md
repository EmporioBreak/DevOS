# AGENTS.md

## Purpose

This repository is operated through DevOS. New local Codex sessions should treat this file as the standing operational contract for work in `EmporioBreak/DevOS`.

The main agent owns the user task and final judgment. DevOS owns coordination, never judgment.

## Automatic current-chat identity

ChatGPT conversation identity is established mechanically from host-provided MCP metadata on tool calls. DevOS uses `_meta["openai/session"]` as the canonical conversation-scoped identity, scoped by `openai/subject` and `openai/organization` when available, and persists only a keyed fingerprint of those opaque values.

Do not generate binding markers, print binding tokens, traverse ChatGPT sidebars, or launch a browser merely to identify the calling conversation. A ChatGPT `/c/<conversation_id>` URL is a separate optional browser route and must only be stored when DevOS directly proves that route, such as for a browser conversation DevOS created or resumed itself. Missing host session metadata is `unresolved`; never infer identity from recency, timing, tool arguments, active tabs, or MCP transport-session ids.

The legacy `bind-chat` command remains diagnostic compatibility only and is not part of normal new-chat startup.

## Working model

- GitHub Issue and linked PR are the source of truth for the task.
- Keep one task-scoped worker graph per Issue. Do not invent new workers, roles, routes, or lifecycle stages during execution.
- All worker tasks start with ChatGPT in the browser. Local Codex workers are a fallback after a browser worker reports `needs_local_worker` with a concrete environment limitation.
- Final task acceptance is not a worker role. The main agent decides `approved` or `changes_requested`.
- If the main agent requests changes, continue the same task and preserve task-scoped worker sessions and the existing PR.

## Main-agent execution boundary

1. The main agent receives the user task, clarifies requirements, plans the complete worker graph, and records the task contracts and acceptance criteria in GitHub Issues.
2. The main agent launches DevOS with the declared graph, then waits for its final-review handoff.
3. DevOS workers perform all implementation, testing, intermediate review, and rework. They review each other and continue their correction loop within the same task.
4. Before the final-review handoff, the main agent may only diagnose an actual execution failure or blocker. Diagnosis must not become parallel implementation, testing, product review, or a takeover of worker work.
5. After the handoff, the main agent performs the final review, decides `approved` or `changes_requested`, and presents the accepted result to the user.

Do not spawn additional subagents or reviewers outside the declared DevOS graph, including through Codex collaboration tools. Do not perform parallel code checks, tests, or early product reviews while workers are executing. Do not add roles or change routing during execution to bypass a worker limitation.

On `changes_requested`, send the findings back through the existing DevOS continuation and wait for another final-review handoff. Preserve the Issue, PR, graph, and saved worker sessions; do not restart the task or create replacement workers.

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

Enter final task review only when DevOS returns:

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

- Browser workers must attempt each task first, including implementation, testing, review, and verification.
- Use a local Codex worker only after that browser attempt returns `needs_local_worker` and identifies the missing capability. Task complexity or an anticipated need for host-local tools does not justify routing directly to a local worker.
- This fallback rule concerns worker execution; the main agent still owns planning, execution-failure diagnosis, and final judgment within the boundaries above.
- Do not claim local verification that was not actually run.
- Keep changes minimal and scoped to the active task.
- Do not mix unrelated browser reliability work, lifecycle changes, or cleanup into a focused task.

## Repository and execution rules

- DevOS is project-local. Its CLI remains a one-shot control surface, but it may start and manage a project-scoped background runtime that continues after the invoking terminal closes.
- The background runtime must be owned by that project, explicitly startable/stoppable through DevOS, and responsible for cleaning up its own child processes and state.
- Do not install or rely on a global/system daemon, login service, LaunchAgent, watcher, or unbounded polling loop for DevOS runtime ownership. Background work must remain project-scoped and bounded to the explicitly started DevOS instance.
- Avoid GitHub Actions for the inner development loop unless a task explicitly requires them.
- Do not create throwaway repositories for smoke tests unless there is a concrete need and explicit approval.
- Preserve intentional `run` / `restart` semantics.
- README is user-facing and should remain concise.

## Change discipline

Small, obvious repository maintenance does not need a new DevOS Issue or worker graph when the main agent can safely perform it directly. Use a normal small PR when appropriate.

This exception covers routine maintenance such as correcting this operational document. It does not permit the main agent to take over substantive worker tasks or bypass the execution boundary of an active DevOS task.

For substantive product behavior, use the Issue/PR workflow and keep the task contract explicit.
