# DevOS Skills Library — Git-backed source of truth

Scope: [Issue #137](https://github.com/EmporioBreak/DevOS/issues/137).
This task adds a **registry and integrity verifier**, not autonomous skill
execution. The DevOS Runner and browser workers are not used for the
current migration.

## Layout and ownership

- `config/devos-skills.json`: reviewable Git-backed registry
  (`version: 1`) with skill IDs, descriptions, versions, dependencies,
  conflicts, allowed scopes, source URLs/licenses, entrypoint and SHA-256
  hashes of **all files**, including nested references, scripts and assets.
- `config/devos-upstreams.lock.json`: upstream source identities, pinned
  Git commits and full-repository SHA-256 snapshots (#124).
- `~/.devos-staging/upstream/<id>/`: private immutable vendor snapshots,
  never checked in as duplicates; rebuilt from the upstream lock.
- Future `skills/devos-*/`: **separate** DevOS adaptations. Their
  `source.kind` must be `adapted` and `derivedFrom` must point to
  the source version; original vendor files and hashes remain unchanged.
- `src/skills-library.ts`: parser, validator, safe file reader,
  directory snapshot, resource-integrity checks, installed/available
  inventory, registration, update preview and reviewed apply.

The initial registry pins **15 original Superpowers skills (74 files)**,
version `6.4.2`, pinned peeled commit
`8ca22dba9a94f28898bbce59f2537ff4d87c747d`.
Registering a skill **does not invoke it**. In particular, original
Superpowers skills that attempt to dispatch independent subagents or take
Git ownership must **not** be used in the DevOS execution graph; adapted
DevOS versions are handled by later integration Issues.

## Library behavior

`parseSkillLibrary` checks all entries, a unique kebab-case ID,
mandatory `SKILL.md`, exact versions, dependencies (including missing
dependencies and cycles), conflicts, supported scopes and origin metadata.
An empty registry is valid; any number of independent skills may be added.

`listSkillAvailability` returns `installed`, `unavailable` or
`integrity_failed`. Every installed skill is rehashed: missing resource,
new unexpected file, symlink, modified file, wrong pinned upstream and
unsafe paths all fail closed. `readPinnedSkillResource` also hashes the
bytes it returns to reject a change between inventory verification and read.

`previewSkillUpdate` reports added, removed and changed resources,
versions and `reviewFingerprint` bound to the exact old/new entries.
`applyReviewedSkillUpdate` accepts a *new version* **only with the
matching reviewed fingerprint**, and does not mutate the original registry.
The caller (Main Agent or owner UI) must obtain meaningful human
approval before submitting the fingerprint for breaking changes.
The fingerprint is an integrity/approval-matching mechanism,
**not proof that a human actually reviewed the diff**. The authorization
and routing implementation is separate (#138–#141).

## Testing

```sh
node scripts/devos-upstreams.mjs verify --root "$HOME/.devos-staging/upstream"
npm run build
npx tsx --test tests/skills-library.test.ts
```

Eight tests cover 15 installed originals and all 74 files,
registration from an empty catalog, multiple skills, missing/cyclic
dependencies, adapted isolation, changed `SKILL.md` and nested
resources, wrong source revision, forbidden path traversal,
version downgrade, same-version drift, diff preview and exact
reviewed update fingerprint.

Next: #138 applies `required/optional/off` to declared roles,
with precedence and an explicit inactive default. #139 distributes
only selected/pinned resources through MCP to verified ChatGPT workers.
#140 installs selected skill sources into isolated Codex worktrees.
