# DevOS 2 — approved worker skills into the existing Runner (Issue #144)

DevOS is the complete system. **DevOS Main Agent** plans the project,
approves scope and worker graphs, and makes final judgments.
**DevOS Runner** does only mechanical execution of **one existing
GitHub Issue** using the declared graph, saved browser sessions and
explicit Codex fallback. This is not a second planning/execution engine.

## Owner-approved preflight (Main Agent only)

`prepareApprovedRunnerSkills` takes the fully formed Main Agent
project plan from #143 plus an explicit stage/role/skill roster
for **every already declared worker**. It independently rechecks:
- Original canonical Spec Kit artifact Git SHA and all user decisions.
- Whole Issue/PR/worker graph approval and separate stage/skill roster
  approval via trusted `verifyOwner` callback. A textual claim
  `userMessageRef` is never proof without this callback.
- Exactly the same worker IDs, order and executors, including
  browser-first and reviewer; role, original pinned Spec Kit stage,
  quality skills, policy precedence, complete sources/versions/hashes.
- All workers' preflight checks **before first assignment is written**.

Each worker receives a host owner-secret HMAC-signed, immutable
per-Issue manifest in
`.devos/skills/assignments/<encoded-repo>/<issue>/<worker>.json`.
The Main Agent then seals another owner-secret HMAC-signed file
`.devos/skills/graphs/<encoded-repo>/<issue>.json`, binding the exact
GitHub Issue/PR, serialized graph SHA and SHA of every worker manifest.
A later attempt to amend a worker roster, change a task or edit files
does not silently reassign; it stops and requires new owner approval.
No MCP tool or model-visible endpoint can seal the graph.

**Important trust boundary:** the actual user-message verifier must
be injected by a trusted host/Main Agent integration. The tests use
explicit synthetic verifiers only; they cannot prove that a real user
approved that exact plan in ChatGPT. A live verification adapter remains
part of staging E2E and must fail closed when not available.

## Strict Runner mode

A DevOS 2 workflow explicitly declares `skillsMode: "strict"` and
`owner: { "mode": "main_agent" }`. Legacy workflows omit
`skillsMode` and remain compatible.

For strict mode, `runWorkflow` loads the owner key from local
environment or project `.env`, verifies the signed graph and all
frozen original skill sources **inside its task lock, before**
restarting state, starting Camoufox, issuing MCP requests or launching
a worker.

On each fresh/resumed worker turn, Orchestrator re-verifies the
complete sealed graph and exact selected manifest before dispatch.
A missing callback/worker, changed original pinned stage, missing
or altered signed assignment or wrong PR blocks the task explicitly.
Browser prompts carry only a non-secret manifest digest, assigned
original stage and instructions to call the existing
`devos_skill_manifest` / `devos_skill_read` tools. These tools
already require an actual signed, live worker-specific ChatGPT grant.

Local Codex is allowed only on an explicitly predeclared browser
`needs_local_worker` route; its `codexSkills.mandatory` becomes
**true** in strict mode, and `prepareCodexSkills` (Issue #140)
installs only the assigned native files in the task worktree before
fresh or resumed Codex execution. Worker graph/status semantics,
independent browser review and same-Issue/PR/session persistence are
unchanged. A Reviewer handoff still requires Main Agent's separate
final acceptance, not a self-approved merge.

## Verification and limitations

```sh
npm run build
npx tsx --test tests/runner-skill-graph.test.ts \
  tests/runner-skill-preparation.test.ts tests/orchestrator.test.ts
```

Tests prove: real pinned source preflight of every worker, independently
approved fake Main Agent issue+roster fixture, signed graph,
missing/wrong signatures, spoofed PR/worker/prompt/stage, strict mode
before browser startup, browser→Codex fallback, preserved reviewer
and final owner handoff, and backward-compatible legacy graph.

This is **actual Runner dispatch/preflight integration**, but
browser/model responses in focused tests are fakes. Real ChatGPT
browser grant and UI execution, original Spec Kit SDD/Bugfix/Assess
stage operation, live transactional GitHub approval/Issue adapter,
full iPhone/web plugin verification and Staging smoke remain
#150/#151 and other release tasks. The Staging constitution is
still an original unratified template; no owner approval is invented.

Versions are locked by a single active Skills Library registry
per skill ID. A running task with an older pin refuses changed
source rather than getting silently migrated. Concurrent release
channels would require explicit versioned snapshots in #154.
Production main, current MCP/authorization state and ngrok
are not modified by this PR.
