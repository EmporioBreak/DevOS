---
name: devos-brainstorming
description: Collaboratively clarify intent, scope, options and approval before DevOS creates implementation workers; preserve existing approvals without prompting again during execution.
---

# DevOS Brainstorming — predevelopment only

Adapted from original pinned `obra/superpowers/skills/brainstorming`
(v6.4.2). The original skill remains available **unmodified** in the
upstream source catalog. This DevOS skill applies its design method
within DevOS Main Agent's planning authority, not a second orchestrator.

## Establish shared understanding

1. **Discover intent.** From the owner's existing message and project context,
   identify intended outcome, users, success criteria and hard constraints.
   Ask one focused question only when something essential is genuinely missing;
   don't ask a question already answered by the owner.
2. **Write back understanding.** Reflect intent, assumptions, trade-offs,
   acceptance criteria and boundaries in an in-chat note or relevant Spec Kit
   `spec.md`. Invite correction and incorporate it **before** implementation.
3. **Carry intent into design.** Preserve goals and constraints in the canonical
   Spec Kit artifacts and GitHub Epic/Issue, rather than an independent
   `docs/superpowers/specs/*` document.
4. **Present choices.** When more than one viable solution exists,
   explain 2–3 options, trade-offs and a justified recommendation.
   Apply DRY/YAGNI; match existing code patterns where appropriate.

## Three request paths and approval boundary

Classify by **actual change surface**, not apparent simplicity:

- **Spike** (feasibility/investigation): Agree the question, a bounded probe
  and whether its output is disposable. Return evidence/recommendation, never
  silently ship a spike as production implementation. A completed read-only
  diagnostic already approved in the user's task does not need a second nod.
- **Bounded** (small change to an existing, understood code path): Inspect the
  actual flow, document the short design, impacted files, tests and acceptance
  criteria in chat or the GitHub Issue. Obtain owner agreement **once before
  modifying behavior**. No forced full-feature spec ceremony unless complexity
  genuinely increases.
- **Architectural** (new product/subsystem or cross-cutting interface):
  Explore actual code/project history, decompose independent user-verifiable
  work into an Epic with Issues, compare approaches, present the proposed
  design and constraints, then use **original** `speckit-specify`,
  `speckit-plan` and `speckit-tasks` for the **single source of truth**.
  Review required artifacts with the owner as they become available; record
  their approval in the Main Agent's Issue planning contract.

### HARD GATE — before execution begins

The DevOS Main Agent must verify that the current Issue's owner-approved
scope, main design decisions and necessary canonical Spec Kit artifacts
are recorded **before launching DevOS Runner** or product implementation.
An owner agreeing to *an idea* does not automatically approve a later
materially different design. For architectural work, ensure the written
spec and implementation plan are explicitly reviewed and approved.
For bounded changes, an approved short design may suffice. For spikes,
approval of the question/probe limits activity to that probe.

**Approval provenance belongs to Main Agent:** keep the approving user
interaction and the exact artifact version or Git SHA. Never fabricate a
user action or treat silence as consent. An approval cannot be reused
for materially different requirements.

**No duplicated approvals:** Once Main Agent confirmed the complete current
task and worker graph, workers must not reopen approval/brainstorming in each
turn or ask for the same decision. If genuinely new material scope, risk or
constraint is discovered, stop that work, record the specific blocker and
return it to Main Agent; do not improvise new worker roles or broaden scope.
The Main Agent decides whether the already approved scope needs to change.

## Working sequence

1. Explore existing repository, files, tests, README, AGENTS.md and applicable
   constraints before proposing architectural changes.
2. Identify outcome, success measures and decomposition boundaries. For
   multi-subsystem projects, make each Issue independently reviewable without
   turning every implementation T-step into a separate GitHub Issue.
3. Present meaningful alternatives and select one only when the owner has
   supplied the necessary decisions; document trade-offs and explicit non-goals.
4. Get the appropriate owner review **during predevelopment**, not after
   starting workers.
5. Record in GitHub the agreed boundaries and link to canonical Spec Kit
   `spec.md`, `plan.md`, `tasks.md`, plus immutable Git revision as needed.
6. Before launch, cross-check acceptance criteria, dependencies and required
   approval. Owner-approved smaller edits proceed without repeated bureaucracy.
7. Hand off to the Main Agent's established planning and skill-selection flow.
   Only DevOS Runner executes the frozen worker graph for one Issue; it does not
   make product decisions or create new subagents.

## Design quality and self-review

**Understand before building:** Write outcomes that the owner recognizes,
separate sourced facts from assumptions, and preserve enough detail for an
independent reviewer to verify acceptance.

**Isolated boundaries:** For each component, describe responsibility,
interfaces, error handling, data flow, dependencies and testability.
Avoid unrelated refactoring in existing code.

**Spec checks and Constitution:** Validate decisions against the existing project Constitution. No "TBD" left as a silently approved requirement; reject
contradictory constraints, ambiguous acceptance conditions and changes that
extend beyond the approved scope. Move unresolved questions back to the
earliest relevant Spec Kit stage (Specify / Clarify / Plan / Tasks), never
mark a quality gate passed without evidence.

**Visual questions:** When the owner genuinely needs a visual design choice,
use explicitly requested or supported visual references rather than
automatically launching the original Superpowers visual-companion server.
Never create additional browser sessions/services merely by enabling this skill.

## DevOS authority boundaries

- Only Main Agent controls cross-Issue project planning, user approvals,
  skill selection and final acceptance.
- Only DevOS Runner coordinates the predefined developer/reviewer/fallback
  graph during execution, preserving the Issue, PR and worker sessions
  throughout correction loops.
- Original Spec Kit owns feature requirements and plan/tasks. This skill does
  not create an independent plan file, new branch/commit/PR, independent
  agent-review graph, or second workflow engine.
- A previously approved change can proceed automatically through its
  established execution flow. **Never claim that an approval happened when
  there is no provenance.**
