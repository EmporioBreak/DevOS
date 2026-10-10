# DevOS 2 — native Codex skills for a task/worktree

Issue [#140](https://github.com/EmporioBreak/DevOS/issues/140).
Codex reads its **native** skill directories from `$CWD/.agents/skills`
and repository parents. The upstream Spec Kit installation already owns
`.agents/skills/speckit-*/SKILL.md`. Keep these official entries unmodified.

## Installation contract

`src/codex-skills.ts` exposes `prepareCodexSkills(root, assignment)`:

- The Main Agent resolves/fixes skill selections for an Issue before Runner
  starts. Browser and Codex fallback use the same approved skill policy,
  **with separate signed manifests for their declared worker IDs**.
- Each manifest lives under
  `.devos/skills/assignments/<encoded-repo>/<issue>/<worker-id>.json`.
  Browser/Codex require the owner-secret HMAC signed version (format v2),
  not editable plaintext or self-declared prompt claims. Re-read on every
  run/resume; a changed signature, version or selected resource fails closed.
- The installer first verifies the **complete** source library and the
  original pinned Spec Kit stage, checks all destination names and hashes,
  then copies selected original/adapted skills into
  `.agents/skills/<registered-skill-id>/` inside the requested worktree.
  It copies all nested reference/script/asset files, not just SKILL.md.
- The installed files retain the upstream SKILL.md **frontmatter name**.
  Codex matches skills by that name, not only directory ID. The installer
  rejects duplicate frontmatter names among assigned skills, existing
  project files, `~/.agents/skills` and `$CODEX_HOME/skills`
  (default `~/.codex/skills`). It never overwrites or replaces an
  existing nonidentical project skill, existing user skill or original
  `speckit-*` directory.
- Copying uses exclusive directory creation. Partial failures clean up
  their new directory, and a crash leaving an incomplete copy blocks
  future runs rather than silently overwriting it. A complete exact copy
  is idempotent on resume. No global skill paths are modified.
- No MCP tool or remote skill-download call is made by the Codex
  installer. Scripts are **copied**, not executed during installation.

`CodexExecutor.run` now runs this check **before** launching the Codex
process. The existing Orchestrator passes trusted Issue/worker identity for
both first execution and the existing Codex session-recovery branch.
Already-created signed assignments are applied automatically.

## Rollout distinction

A `mandatory: true` assignment requires a valid signed manifest and
fails before Codex execution otherwise. During this unmerged migration,
existing DevOS tasks **without new #144 assignments** still use
`mandatory: false`, preserving current behavior without inventing or
automatically assigning a skill. **Issue #144 must enable mandatory
pre-launch frozen assignments** for DevOS 2.0; this task does not claim
the full preflight→Runner graph integration is deployed.

The staged source cache defaults to `~/.devos-staging/upstream`; release
setup #154 must choose a production pin. Missing pinned files, incompatible
library versions or paths outside the trust root stop setup.

The contents of generated `.agents/skills` directories are task-local
runtime artifacts. Do not add them to a PR in the target application.
The DevOS migration PR contains only the **installer**, not installed
user-profile credentials, local copies or temporary task data.

## Verification

```sh
npm run build
npx tsx --test tests/codex-skills.test.ts
```

Tests exercise copied native `SKILL.md` and nested assets, unchanged
original Spec Kit, repeat/resume, browser-first→Codex fallback with the
same chosen IDs/versions, no calls to MCP through a fake local Codex
CommandRunner, missing/unsigned/wrong-key assignments, source drift,
tampered official stage, existing project collision, symlink parent and
user-level frontmatter `name` collision.

Codex CLI `0.160.1` is installed locally and confirms the CLI interface.
Repository-native `.agents/skills` discovery is documented by OpenAI:
https://developers.openai.com/codex/skills
Actual interactive Codex model execution and live ChatGPT browser fallback
are **not** proved by unit tests; #144/#150/#151 remain the live acceptance
steps. Original Codex/Spec Kit user skills and host profiles remain untouched.
