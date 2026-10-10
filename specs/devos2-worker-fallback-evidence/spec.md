# Feature: evidence-based host fallback and executor-specific skill loading

**Issue:** EmporioBreak/DevOS #228
**State:** DRAFT, original stages not attested; owner-signature required

## User stories
- As the DevOS owner, when a browser worker has access to my Mac via approved Desktop Commander, it should perform implementation rather than delegate because the task is difficult or carries risk.
- As a local Codex worker, I receive exact signed native skills without needing a browser-worker MCP grant or owner-entered password.
- As Main Agent, I see a verifiable justification for every local fallback and remain in control of blocked/failed task recovery.

## Functional requirements
- FR-001: Strict worker prompts are executor-specific. Browser workers use devos_worker_probe/noop and authenticated devos_skill_manifest/read; Codex workers use locally prepared signed skills only.
- FR-002: For browser needs_local_worker, require a specific host-only missing capability and independently checkable proof of a failed or unavailable operation; reject complexity, caution or model assertion alone.
- FR-003: Validate exact task, worker, turn and signed MCP report before admissible local routing; keep independent audit evidence without private chat URL/token/password in GitHub.
- FR-004: Rejected fallback must not dispatch Codex; retain the browser conversation and PR and surface actionable blocked/correction state without blind replay.
- FR-005: Genuine proven host limitation may route only to the predeclared Codex worker, never create an extra worker or route.
- FR-006: Preserve #214 trusted final review, #224 wake-up state and #226 browser work/state without forced approval, chat replacement or task restart.
- FR-007: Status and transport failure do not authorize replay of may-have-submitted browser sends; continue default-deny and independently signed skill policies.

## Acceptance
- RED/GREEN: Codex prompt never contains devos_skill_manifest/read or browser authorization flow.
- RED/GREEN: browser worker with available authorized Mac capability cannot auto-delegate merely on subjective risk.
- Real independently evidenced inaccessible host-only tool can use exact signed fallback, and unauthorized/malformed proof cannot.
- Regression: existing DevOS statuses, review, same-conversation continuity, owner approval boundary and worker report security stay valid.

## Main-Agent-planned capability routing (owner clarification)
- Main Agent decomposes each Issue into concrete actions and selects a capable executor for every worker **before** sealing the owner-approved graph. The algorithm does not hard-code issue categories such as UI, iOS, security, tests or coding to executors.
- Assign browser workers wherever actual authorized Desktop Commander MCP operations and verified browser capabilities suffice for the required action. Assign predeclared local Codex workers when the particular required operation exceeds those tools, provided the local executor actually has the capability.
- Human-observed native UI testing, iOS Simulator interactions, security investigations and other scenarios are only examples of capability differences, not rigid routing categories. A shell command is not by itself proof of human-style screen observation.
- The exact Main Agent graph is owner-approved and HMAC-sealed with every node's executor, prompt, skills and transitions. A **planned** Codex stage may be the initial stage or follow a prior worker's ordinary `done`; this is not a speculative runtime `needs_local_worker` fallback.
- The Runner must deterministically execute the signed graph. It cannot reassign an action from browser to Codex by interpreting the Issue title, task risk or worker preference. Unplanned `needs_local_worker` still requires genuine independently verified host-only evidence, and routes only to the predeclared fallback. No duplicate browser submits or session replacement.
- If neither available environment can perform a required action, the Main Agent must surface the capability gap; do not claim success, downgrade the acceptance test or invent additional workers.
