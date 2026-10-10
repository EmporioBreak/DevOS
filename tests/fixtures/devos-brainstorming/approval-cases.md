# DevOS brainstorm approval examples (synthetic tests, NOT real approvals)

## Architectural path

A new project requires an agreed problem, a written specification and a
written plan. Main Agent may discuss sections sequentially before execution;
an architectural idea alone is **not** permission to implement changed code.

Example Issue history and approval provenance (mock references only):
- User request: a new service that supports offline search
- Main Agent: explains options, interfaces, error handling and alternatives
- Spec Kit `spec.md`: owner reviewed exact commit and acceptance criteria
- Spec Kit `plan.md`: owner reviewed subsequent exact version
- **Execution decision**: predeclared workers in DevOS Runner
- If one approval stage is missing: **needs owner review**; no permission inferred
- Once approved, implementer and reviewer **do not request again**.

## Bounded path

An existing app's small search UI change is described in chat as exact
behavior, files and tests. Owner approves the described current scope once,
before implementation; the DevOS Runner follows its Issue contract without
new questions on every worker turn. When a new costly dependency appears,
return to Main Agent for a newly scoped decision.

## Spike path

Owner approves a temporary read-only feasibility probe with known boundaries.
Report the finding. A throwaway experiment cannot become production code or
a new GitHub feature Issue merely because the probe succeeded.

All paths require actual evidence of a user decision. A serialized fixture,
a prompt assertion or the user's silence cannot authenticate consent.
