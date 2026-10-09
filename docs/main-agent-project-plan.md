# Main Agent project planning and immutable Issue contracts — #143

DevOS is the complete development system. The **DevOS Main Agent**
owns project intake, roadmap, Epic decomposition, GitHub Issue/PR scope
and final acceptance. **DevOS Runner** is one technical part of DevOS:
it executes just one already-declared Issue's worker graph. It never
chooses the next project Issue, expands scope, spawns additional
reviewers or creates a new PR on its own.

## Project-size decision

- **Small bounded change**: one independently testable GitHub Issue.
  Exact microtasks `T001`–`T00N` remain in original Spec Kit
  `tasks.md`; they do not become separate GitHub Issues.
- **Product / several independent subsystems**: the Main Agent
  creates a parent Epic plus **independently testable** child Issues.
  Each Issue has its own canonical Spec Kit files, scope, non-goals,
  acceptance criteria, Git commit and frozen worker graph. Dependencies
  form a DAG. Topological order is a proposed Main Agent plan, not a
  task-dispatch algorithm built into Runner.
- **Read-only assessment**: no implementation Issue or Runner unless
  a new feature/implementation scope is subsequently approved.

This module assumes that GitHub Issue IDs have been **reserved by Main
Agent beforehand**, allowing the canonical original Spec Kit artifact
contract to reference an exact Issue number and exact Git SHA.
Reservation is *not* execution approval. An Issue may exist as a draft
before the owner's design/spec/plan consent. Actual approved contracts
are only published after independent verification. Creating a GitHub
Issue is still a Main Agent/plugin action, not a hidden worker action.

## Machine-verifiable contract

`prepareApprovedProjectPlan(projectPlan, { projectRoot,
verifyApproval })` validates each Issue against #127 and #142:

- Exact repo, GitHub Issue ID, original Spec Kit `spec.md` /
  `plan.md` / `tasks.md` and their content at a **real Git commit**.
- Explicit scope/non-goals/user scenarios/acceptance criteria,
  alternatives for architectural changes, owner-approved content
  digest and **trusted approval verification** for that digest.
- All dependency links are declared *both* in the owner's
  artifact contract and in the Epic DAG. Changing either requires
  new owner review. Duplicate issues, duplicate canonical artifact
  directories/titles, missing edges, self-dependencies and cycles
  fail before publication.
- Exact immutable, parseable `Workflow` with owner
  `main_agent`; first worker must be ChatGPT browser, local Codex
  may only be reached by a **predeclared** browser
  `needs_local_worker` route. Implementation must declare a
  separate reviewer. Never create new agents after dispatch.
- **Independent graph approval**, bound to the exact graph, Issue
  dependencies, linked PR, Epic identity and the owner's intake
  digest. A string that claims a user approved something is
  insufficient: the caller supplies an independent trusted
  `verifyApproval` function. New or changed graph needs genuinely
  new verification, not silence or an LLM assertion.
- Linked PR and worker-report references are part of Main Agent's
  acceptance evidence, never authority for a worker to publish.
  Public worker-report references accept only GitHub links from
  the target repo without query tokens or private paths.

The result is a reproducible `VerifiedProjectPlan` with a
topological Issue ordering and SHA-256 fingerprint. Each Issue body
contains exact scope/non-goals/acceptance, dependency numbers,
a pointer to original pinned Spec Kit artifacts, the already
predeclared worker graph hash, a single
`<!-- DEVOS_MAIN_AGENT_PLAN_V1 -->` metadata block and the
canonical `<!-- DEVOS_SPECKIT_V1 -->` block from #127.
No duplicate `docs/superpowers/plans/*` source is created.

## Safe GitHub publication

`publishApprovedIssue(proposal, issue, expectedBodySha256,
provider, { projectRoot, verifyApproval })` **re-verifies the entire
owner plan and original artifact SHA** before writing. It deliberately
does **not** accept an arbitrary model-supplied object marked
`verified` as proof of authorization.

The authenticated GitHub adapter must:
1. Read the actual open Issue; ensure it still belongs to the
   planned repository/number.
2. Verify any linked PR against the exact Issue using the real
   GitHub provider API.
3. Accept a conditional `updateIssue` carrying the expected
   body hash and reject concurrent edits.

Publisher appends to, **never replaces**, existing Issue notes.
It is idempotent when the approved block is already present. If a
different approved contract already exists, the publisher fails
closed until Main Agent records a new owner decision and safe
revision. It does not silently overwrite an existing PR or force
another Issue to be created. Live GitHub adapter wiring into the
ChatGPT Main Agent orchestration remains an integration check.

GitHub may not provide an atomic If-Match update on every supported
connector; a provider lacking compare-and-swap guarantees must
reject this API rather than pretending concurrent writes are safe.
Tests exercise a mock provider with enforced CAS; they are not
proof that a live GitHub connector implements that feature.

## Real verification and limits

```sh
npm run build
npx tsx --test tests/main-agent-project-plan.test.ts \
  tests/main-agent-intake.test.ts tests/spec-kit-contract.test.ts
```

Synthetic tests use actual temporary Git repositories with committed
Spec Kit artifact files and mock host-verifier/provider adapters:
three independent dependent Issues (DAG), one small Issue,
cycle/duplicate/unapproved changed scope/worker rejection,
preservation of existing GitHub notes, idempotent publication,
conditional update, linked-PR verification, and fail-closed
handling of forged human consent.

**Not yet represented as live E2E:** the host's actual
ChatGPT user-message approval attestation, a live GitHub
transactional Issue adapter, the complete original SDD workflow
(#128/#129/#131/#132), and Runner's operational enforcement of
the graph/skills/stages (#144). Those must be integrated and
independently tested in Staging before production promotion.
