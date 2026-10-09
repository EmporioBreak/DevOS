# AGENTS.md

## Purpose

This repository is operated through DevOS. New local Codex sessions should treat this file as the standing operational contract for work in `EmporioBreak/DevOS`.

The main agent owns the user task and final judgment. DevOS owns coordination, never judgment.

## Browser conversation continuity

DevOS saves exact conversation URLs for browser-worker conversations it creates and resumes them through task-scoped session state. It does not attempt to identify or recover the URL of an arbitrary user-created ChatGPT conversation through MCP requests, markers, or ChatGPT UI traversal.

## MCP chat authorization: on demand, with worker isolation

**Never request authorization just because a new ChatGPT conversation starts.**
Ordinary chats that do not need DevOS or Desktop Commander must not call
`devos_noop`, open a password form, or interrupt the user.

Before a main-agent conversation actually uses DevOS/Desktop Commander MCP,
call the side-effect-free `devos_noop` to check that conversation's approval.
If it returns `authorization_required`, call `devos_authorize_chat` with
empty arguments **immediately in the same assistant turn** to show the only
inline approval form. Never ask the owner to send an extra message.
When a normal DevOS/Desktop Commander tool returns `authorization_required`,
the requested operation has not run: call `devos_authorize_chat` in the same
turn. Ordinary tools MUST NOT own the approval MCP App template because
ChatGPT iOS renders empty black cards on every later tool result;
do not send the user to plugin settings, do not claim the app is disconnected,
and do not tell them to type another message. The widget sends exactly ONE auto-continuation request to ChatGPT after
successful approval: standard MCP Apps `ui/message` when negotiated, or the
legacy ChatGPT `sendFollowUpMessage` bridge as a fallback. Do not tell the
owner to type "Готово" after filling an inline form: the widget itself
requests continuation. Only if the widget explicitly says the client did
not confirm the continuation may the user need to retry the original task.
This continuation is a client capability, not a server guarantee; never
automatically replay an unapproved, state-changing MCP operation.
If the client fails to render the inline form from
`devos_authorize_chat`, present the exact `approval_url` returned by
THAT authorization tool as a clickable HTTPS link for Safari. Ordinary
tools and `devos_noop` intentionally do not issue approval tickets or
return an attached widget.
Do not redirect users to ChatGPT plugin settings or collect their password
in chat. If no valid URL is returned, call `devos_authorize_chat` with
empty arguments to obtain one. The URL contains a five-minute one-use
challenge in its fragment; never invent or reuse another chat's link.
After owner approval in Safari, ask ChatGPT to retry the original action;
the original denied operation was not performed or queued.
Mobile `/share/` URLs may be accepted as owner-password-entered labels
but are public snapshots, not proof of a private conversation. The grant
always binds the authenticated MCP session and OAuth client, not the share URL.
On successful widget approval, auto-continuation is a client capability and
may be unavailable on some ChatGPT clients; never replay side effects twice.
Never use `devos_worker_probe` for a manually created main-agent chat: it
cannot discover the private chat URL, and cannot replace the password/URL
owner-approval flow. The worker probe is exclusively for DevOS-created workers.
When DevOS returns `authorization_pending`, an earlier MCP call already
created this chat's **one** authorization form. Do not call
`devos_authorize_chat` again or ask for another confirmation: wait for
the existing form or show its provided Safari fallback URL. Only call
`devos_authorize_chat` if no live approval request is pending and the user
needs an explicit fallback form. The owner enters a supported ChatGPT chat URL and
the **separate chat-access password** into the widget; the password must
never appear in prompt text, tool arguments, model output, or GitHub.
An authenticated local `./devos connector access approve` remains a fallback
for clients without MCP Apps UI. Until the gateway confirms authorization
for the same session, do not create Issues, launch workers, or operate the
Mac through MCP. Declined or unavailable approval means no MCP side effects;
do not repeatedly prompt unless the user retries the MCP operation.

DevOS-created browser workers must not request the owner's chat-access password.
Their MCP calls may be authorized without interaction **only after** the
trusted local orchestrator and the gateway have proved and registered that
specific active worker conversation's MCP identity. Self-declared worker
roles, task IDs, Project membership, copied conversation URLs, and OAuth
client identity alone never grant access. Until that worker authorization
path is verified and implemented, deny rather than bypass the gate.

A pasted URL alone is not authorization on a shared ChatGPT account. If
usable host session metadata is missing, contradictory, or ambiguous, fail
closed and explain the block. Do not use marker/sidebar UI traversal.

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
