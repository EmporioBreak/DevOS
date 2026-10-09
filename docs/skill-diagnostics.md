# DevOS 2 — Skills diagnostics and source-update review

Issue [#141](https://github.com/EmporioBreak/DevOS/issues/141).
The Skills Library registry, upstream lock and user policy remain the
Git-backed source of truth. This module is **read-only**: it does not install
a skill, change a pin, start Runner, commit, merge or deploy.

## Diagnostic commands

From the local project root after `npm run build`:

```sh
./devos skills status
./devos skills issue EmporioBreak/DevOS 411 developer developer execution implement superpowers-test-driven-development
./devos skills preview superpowers-writing-plans /path/to/candidate-entry.json
```

Alternatively `node dist/src/cli.js skills status`. The Issue form accepts:
`<repo> <issue> <worker_id> <role> <planning|execution> <stage|null>
[optional-skill-id ...]`. The supplied optional IDs represent candidates
proposed by Main Agent; they do not retroactively authorize new selections
for a running worker.

The report includes: origin/commit/version for each skill, installed /
unavailable / integrity_failed state, pinned upstream commit, applied
scope/mode, policy fingerprint and count; for a concrete Issue it also
computes a deterministic **effective** role-specific skill list. When the
local owner key exists, it separately verifies and displays the already
frozen HMAC-signed assignment; `assignmentMatchesCurrentPolicy` flags whether
new settings would differ from this frozen assignment without rewriting it; a tampered/unsigned assignment is marked
`invalid`, not presented as a verified decision. Missing owner key is
`unverified`, not magically authorized.

Readiness is reproducible from the same Git config/upstream resources.
Every source file and its nested references/scripts is re-hashed. Errors
are reported with a safe cause and next action; raw exception paths,
secrets and credential contents are not included in the returned JSON.

## ChatGPT MCP tools

`devos_skill_diagnostics({})` returns global registry status.
A complete optional Issue query adds
`repo, issue, worker_id, role, phase, spec_kit_stage,
optional_candidates?`. Partial context is rejected, not guessed.

`devos_skill_update_preview({skill_id, candidate_json})` accepts the
**candidate Skills Library entry** as JSON. It checks compatibility with
the currently registered source and shows old/new versions, added/removed/
changed paths, exact comparison fingerprint and upstream revision changes.
It flags any DevOS-adapted skill whose `derivedFrom` matches the
old original/version, so adaptations are reviewed whenever their source
changes.

Both tools require owner-approved ChatGPT chat fingerprint through
the existing lazy-authorization gateway. A model-declared worker role
or bearer OAuth token alone cannot read the owner's effective policy.
Both are marked read-only and carry **no inline authorization form**.
The tools do not expose secrets from the actual Mac connector.

## Update / release gate

A preview always returns `releaseReady: false` with review blockers.
A matching fingerprint is **not** proof that a person approved a change.
Before advancing a pin: inspect original upstream changes, ensure files
and scripts match their new expected SHA-256s, revisit any derived
`devos-*` variants, get actual owner review, commit a reviewable PR,
run the focused and comprehensive Staging tests, and only then
promote the release.

Version rollbacks and same-version hash edits are rejected by the
existing Skills Library preview validator. The module does not
silently download an upstream revision, switch to an unknown tag, or
modify the original vendor copy.

**Multi-version caveat:** the current registry has a single active version
per skill ID. A previously frozen assignment that refers to an older pin
will fail closed after an update. True simultaneous release channels
need an explicitly versioned snapshot model in the integration/release
work (#144/#154); this task does not claim that coexistence is complete.

## Tests

```sh
npm run build
npx tsx --test tests/skill-diagnostics.test.ts
npx tsx --test --test-name-pattern='loopback HTTP refuses anonymous' tests/connector.test.ts
```

Cases include clean 17-skill catalog, intentionally altered upstream file,
same-task HMAC-verified and wrong-secret assignments, deterministic
role/Issue policy, original Superpowers version comparison with
DevOS-adapted dependents, CLI status/preview, strict MCP inputs and
owner vs unapproved-chat live MCP SDK authorization. No private runtime
profile, token or password is exported to GitHub.
