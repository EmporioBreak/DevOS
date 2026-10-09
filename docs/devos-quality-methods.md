# DevOS quality skills policy — original Superpowers, no competing Runner

Issue #135 · DevOS 2. The official `obra/superpowers` originals
remain immutable and are registered by their original upstream hashes in
`config/devos-skills.json`. This task adds **method compatibility policy**
and verifiable quality demonstrations; it does not activate skills in a
worker without the Main Agent's explicit assignment.

## Approved original methods

| Phase / worker | Original skill | Required evidence |
| --- | --- | --- |
| Implement / developer | `superpowers-test-driven-development` | Observed RED test before implementation, GREEN after minimal change, REFACTOR with passing verification |
| Debug / developer | `superpowers-systematic-debugging` | Reproduction, causal mechanism, regression that fixes the actual cause |
| Review feedback / developer | `superpowers-receiving-code-review` | Verify concrete claim against code, accept true findings, explain tested disagreements |
| Complete / developer and review / reviewer | `superpowers-verification-before-completion` | Fresh observed test output, real PR diff and acceptance coverage before declaring `done` or `approved` |

Source and roles are encoded in
`config/devos-quality-methods.json`, checked with
`src/quality-methods.ts`. The policy fails closed if any approved
original quality method is missing or its pinned resources have changed.
The policy is advisory to Main Agent selection, not a second executor
or self-authorizing tool.

The original `superpowers-requesting-code-review` directly dispatches
another subagent; it is **prohibited from automatic activation**, as are
original Superpowers independent executor, parallel-agent, branch and
worktree management skills. The DevOS Main Agent declares reviewers in
the complete worker graph **before** launch; DevOS Runner dispatches only
those predeclared workers. Feedback corrections stay on the same Issue
and PR.

## Real RED → GREEN fixture

`tests/fixtures/quality-methods/buggy.mjs` trims and silently truncates
a normal query. `query.test.mjs` checks that valid input is not truncated
and overlong input triggers a validation exception. Against `buggy.mjs`,
Node's test runner returns **exit 1 / 2 failed**; against
`fixed.mjs` it returns **exit 0 / 2 passed**. The regression test suite
executes both and checks the actual statuses and TAP output; this is
not a static assertion about strings.

`root-cause.md` records the causal mechanism and examples of
technically valid vs invalid reviewer feedback. These are synthetic
training fixtures, not claims about an actual production bug.

For non-code tasks (configuration, documentation, exploratory spike),
don't invent an impossible RED unit test: use appropriate executable
structural checks, file diffs and manually inspectable evidence.
Any genuine inability to test a scoped production change should be
reported to Main Agent rather than quietly claiming full verification.

## Current limits

This PR establishes the **original skills + policy + tests**.
Future #136 compatibility preflight must integrate its selection rules
with actual per-worker manifests, #138 must resolve `required/optional/off`
without silently skipping required quality methods, and #144 / #145 must
validate live runner/ChatGPT behavior. No skill in this policy creates
new GitHub Issues, branches, worker roles or review conversations.
