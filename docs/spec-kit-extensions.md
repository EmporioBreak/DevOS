# Spec Kit extensions — GitHub-first integration for DevOS

Installed **unmodified official** pinned `v1.1.2` extensions through
`specify extension add git`, `specify extension add github`, and
`specify extension add agent-context`. Original extension files/scripts
and commands remain intact; only project-specific settings are changed.

## Git ownership boundary

`DevOS Main Agent` owns GitHub Issues, branches, worktrees, commits and PRs;
`DevOS Runner` executes a predeclared graph for one Issue. Do not let
Spec Kit Git Extension implicitly initialize a repository, create feature
branches, or auto-commit. The upstream installed extension registers
**two mandatory Git hooks** (`before_constitution`, `before_specify`)
and 16 optional commit hooks: the project-local `.specify/extensions.yml`
has `enabled: false` for **all 18 hooks**. Manual original `speckit.git.*`
commands remain discoverable, but are **not authorized to run automatically**.
`.specify/extensions/git/git-config.yml` also retains
`auto_commit.default: false` and disabled per-event commits.

The original GitHub `speckit.github.taskstoissues` extension is installed
but *never auto-triggered*. Its current implementation maps each `T001`
microtask to its own Issue and deduplicates by global task-number titles;
this is not the DevOS Epic/Issue decomposition contract. Use it only
if the Main Agent explicitly chooses that opt-in and verifies scope.

## Agent context and task isolation

`agent-context-config.yml` explicitly targets `AGENTS.md`, using
`<!-- SPECKIT START -->` and `<!-- SPECKIT END -->` delimiters.
Context updates may change only the managed portion; keep the
existing DevOS safety/ownership rules outside the markers unchanged.

Bind feature operations to the correct worktree and task:

```sh
export SPECIFY_INIT_DIR="$PWD"
export SPECIFY_FEATURE_DIRECTORY="$PWD/specs/<issue>/<feature>"
export SPECIFY_FEATURE_NO_PERSIST=1
```

Use one isolated worktree per independently executing task. With these
environment variables, Spec Kit feature scripts must not write shared
`.specify/feature.json` pointers, and they cannot switch the other
task's context. The DevOS Main Agent is responsible for GitHub dependencies
between Issues and approves which feature artifacts belong to each.

## Verification

Official `specify extension list --json` confirmed git 1.0.1,
github 1.0.1, agent-context 1.0.2; 17 skills in total.
`AGENTS.md` SHA-256 before/after installation was unchanged.
`npm run build` and four focused tests pass, including exercising
the **original Python context-update script** in two independent
temporary task roots: each file kept its existing DevOS content and
received exactly one own-task marked section, not the other task's.
Tests also reject unexpected enabled automatic Git hooks.

Never run `specify workflow run`, `speckit.git.initialize`,
`speckit.git.feature` or automatic `taskstoissues` as the normal
DevOS task process. Existing production checkout/MCP remains unchanged.
