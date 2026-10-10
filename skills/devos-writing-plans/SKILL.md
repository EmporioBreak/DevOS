---
name: devos-writing-plans
description: Enrich the single canonical Spec Kit plan.md and tasks.md with exact files, interfaces, TDD steps and verifiable checks before DevOS Runner starts.
---

# DevOS Writing Plans

## Overview

Write implementation plans for an engineer who has not seen this codebase or this spec. Assume they write idiomatic code in the project's language once they know the exact interface and the exact test, and that they will make a reasonable choice wherever the plan leaves one open. What they cannot know is what you decided: which files, which names and signatures, which values from the spec, which tests prove each task. Document those. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent verifiable checkpoints; Git commits are controlled by DevOS.

**Activation:** The DevOS Main Agent selects this method during predevelopment. An execution worker must not initiate new planning approval dialogues after the user has already approved scope.

**Context:** The Main Agent owns project planning and GitHub Issue decomposition. The DevOS Runner only executes the already declared graph for each Issue. Any isolated worktrees are created by DevOS's own Git management; this skill never creates or switches branches.

**Single source of truth:** enrich the original Spec Kit `specs/<scope>/<feature>/plan.md` with architecture, constraints and interfaces; generate executable T-steps only in its original `tasks.md`. Never create another independent plan or task list. The approved GitHub Issue links to the exact files and Git commit SHA using the DevOS Spec Kit artifact contract.

## Scope Check

If the specification covers independently verifiable subsystems, the Main Agent should already have decomposed the work into GitHub Issues with their own canonical Spec Kit artifacts. If the task has not been decomposed, return this mismatch to the Main Agent before the Runner starts. Each approved Issue must produce independently testable software without inventing new tasks during execution.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and can be
independently reviewed by the already predeclared DevOS reviewer. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Step Granularity

**Each step is one action with a checkable result:**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Record test evidence for the assigned Issue/PR" - step

## Canonical Spec Kit plan.md

Use the **original unchanged** `speckit-plan` skill and template first. Never replace the original plan header, Constitution Check or Project Structure with another independent template. Enrich the single `plan.md` as follows:

- **Summary / Technical Context:** Exact Goal, Architecture, Tech Stack, target platform, language/version and main constraints copied from approved `spec.md`.
- **Project Structure:** Exact source and test file paths, ownership boundaries and key public interfaces. Name input/output types and failure modes, not invented implementation details.
- **Constitution Check:** Include constraints inherited from the project's constitution and record any explicitly approved exception. Never mark a failing gate green without evidence.
- **Review Focus:** Include up to five high-impact input classes/failure modes, such as ambiguous data, cancellation and broken dependencies, with the test/acceptance criterion that will cover each. This is an addition to the original `plan.md`, not a second document.
- **Related GitHub Issue:** Link the single independently verifiable Issue and its dependency on the approved `spec.md`. The Main Agent updates the source/version link when the files are committed.

`plan.md` is the architecture/decisions document. Do **not** write the full task execution checklist inside it: that belongs to `tasks.md` created by the original `speckit-tasks` skill.

## Canonical Spec Kit tasks.md

Use the original `speckit-tasks` skill and retain its phase/user-story structure and `- [ ] T001 ...` notation. Break down requirements into steps that are independently verifiable; do not turn every T-step into a new GitHub Issue.

For each implementation task, specify exact files and signatures, dependencies/interfaces and measurable verification. Keep one task responsible for one independently checkable deliverable. In appropriate code changes, group RED-GREEN-REFACTOR into the same task and make the commands and expected failures/passes explicit.

### Example within an original tasks.md user-story phase

```markdown
## Phase 3: User Story 1 — Search (P1)

**Independent Test:** Execute `npm test -- search.service.test.ts` and verify
invalid input yields the stated validation error.

- [ ] T007 [US1] RED: add `tests/search.service.test.ts` for `search(query: string): SearchResult[]`; run `npm test -- search.service.test.ts` and expect FAIL because `search` does not yet exist
- [ ] T008 [US1] GREEN: implement `search(query: string): SearchResult[]` in `src/search.service.ts`; consume `normalizeQuery(input: string): string` from T005; run the same test and expect PASS
- [ ] T009 [US1] REFACTOR: remove duplication without altering the public interface; run `npm test -- search.service.test.ts` and expect PASS

**Interfaces:** T005 produces `normalizeQuery(input: string): string`;
T008 produces `search(query: string): SearchResult[]` for T010.
```

Tests-first methodology applies where the change can be tested. For documentation-only/configuration tasks, use explicit structural checks or a written verification evidence target; do not invent an impossible failing unit test. Follow project conventions for test command syntax; sample above is illustrative only. **The Main Agent** controls Git commits/PR ownership and release decisions, not this skill.

## What a Step Contains

A step is done when the implementer can write exactly one reasonable thing
from it. That is the whole requirement: unambiguous, not complete. Each kind
of step carries what makes it unambiguous and nothing more:

- **A test step:** the test's name and its assertions, as code, with the
  spec's exact values in them.
- **A code step:** the exact signature (name, parameters, return type), the
  file it lives in, and the specific values the spec pins. The implementer
  writes the body. A body appears only for an algorithm the signature and
  tests do not determine, or for exact copy the spec fixes.
- **A verification step:** the command to run and the output that means it
  passed.
- **A reference to another task:** that task's Interfaces block says what
  to use; the plan does not repeat that task's code.

A plan is the set of decisions the implementer cannot make alone. A plan
longer than the code it describes has written the code instead. Lines that
decide nothing ("TBD", "handle edge cases", "add appropriate validation",
"write tests for the above", a type or function no task defines) are the
opposite failure, and the self-review catches both.

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Step scan:** Every step must let the implementer write exactly one reasonable thing, and no step may carry more than that: a line that decides nothing is a gap, a function body the signature and tests already determine is a transcript. Fix both.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Review Focus:** For each input class or failure mode the spec implies, is there a task whose tests exercise it? The five uncovered ones most likely to bite a person go in the Review Focus section, and each line there gets its test added to the owning task. An empty section means you checked and found none, not that you skipped the check.

**5. Proportion:** Compare the plan's length to the spec's. A plan several times longer than the spec it implements is a transcript of the program, not a plan. If code blocks are most of the document, replace bodies with signatures, test names and assertions, and check that each step is still unambiguous.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

## DevOS Handoff (before implementation)

1. Self-review the original `plan.md` against the already approved `spec.md`; ensure requirements, interfaces, filenames, constraints, test-first actions and review-focus cases match.
2. Check that the original `tasks.md` expresses the accepted implementation steps, priorities and dependencies. No second checklist in a separate planning tree.
3. The Main Agent records the exact Git SHA of these artifacts and the Issue/PR reference. It chooses and freezes the complete worker graph and required/optional/off skill assignments **before** invoking DevOS Runner.
4. If a material requirement or design decision has never been approved, return the specific ambiguity to the Main Agent **before** any implementation. If approval was already given for this scope, do not ask again at each worker turn.
5. The DevOS Runner alone coordinates workers and recovery; there is no skill-managed executor, new subagent, independent review graph, branch switch, commit, merge or deployment. Implementation and final acceptance remain within the predeclared DevOS worker/main-agent boundaries.

The adapted skill inherits the **planning quality method** from the original upstream Superpowers writing-plans, not its orchestration instructions. Its original is preserved byte-for-byte and SHA-pinned outside this directory.
