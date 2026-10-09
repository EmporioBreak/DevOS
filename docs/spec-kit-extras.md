# Spec Kit S03 — official Bundles, Artifact CLI and Event CLI

This integration deliberately **does not create a second workflow engine**.
DevOS Main Agent retains task planning/approval and DevOS Runner remains the
sole executor of one Issue. These commands come from the **original, unmodified**
Git-pinned Spec Kit `v1.1.2` (`959e866caa3618bf3dc290d5dca33394365af9c6`).
Their upstream source integrity is checked with `scripts/devos-upstreams.mjs`.

## Read-only discovery

```sh
node scripts/devos-upstreams.mjs verify --root "$HOME/.devos-staging/upstream"
SPECIFY="$HOME/.devos-staging/upstream/spec-kit"
uvx --offline --from "$SPECIFY" specify bundle search --offline --json
uvx --offline --from "$SPECIFY" specify bundle list --json
uvx --offline --from "$SPECIFY" specify artifact list --json
uvx --offline --from "$SPECIFY" specify artifact info command:speckit.github.taskstoissues --json
uvx --offline --from "$SPECIFY" specify event run --help
```

`specify artifact info` exposes provenance and an `extension:...` lookup id;
use `specify artifact lookup <lookup-id> --json` for its original declaration.
Unlike Artifact CLI, `specify event run <command> <event> [timeout]` **can
execute scripts** and is not a safe read-only introspection command. Never run
it on a live connector or task as a generic diagnostic. In the isolated smoke,
an unregistered event is an original **successful no-op (exit 0)**. That does
not prove any handler executed successfully.

## Bundles are opt-in distributions, not orchestrators

The reviewed upstream `bundles/bugfix/bundle.yml` and
`bundles/assess/bundle.yml` include original `bug`/`assess` extensions and
original `bugfix`/`assess` workflow files, **not Presets or step payloads**.
`inspectOriginalSpecKitBundle` accepts only these two IDs and their pinned
SHA-256 manifest bytes. Its result is an inspection record, **not approval**
to install a bundle or run a workflow. New, modified or catalog-discovered
bundles (including community sources) require a fresh independent review.

Only after explicit owner approval and within a separate disposable or task
worktree may an operator use the upstream installer, for example:

```sh
uvx --offline --from "$SPECIFY" specify bundle validate \
  --path "$SPECIFY/bundles/bugfix/bundle.yml" --offline
uvx --offline --from "$SPECIFY" specify bundle install \
  "$SPECIFY/bundles/bugfix/bundle.yml" --offline
```

On a fresh Spec Kit checkout initialization may require the original
`--integration codex`. Offline local manifest installation uses source under
the **pinned local Git checkout**, not the upstream catalog's mutable `main`
branch URL. Verify any existing extension/workflow version overlap before
installing. Never install on running Production or shared Staging checkout.
Never call `specify workflow run`: installed workflow files are source content,
not a license to start Spec Kit's competing runtime. Run the compatible
original skills through the already frozen DevOS worker graph instead.

The existing `speckit.github.taskstoissues` skill is **manual opt-in only**.
It creates an Issue for each TNNN and deduplicates by repo-wide task ID;
this is NOT DevOS's Epic/Issue decomposition. Normal feature execution MUST
NOT invoke it. All 18 upstream Git hook bindings remain disabled; do not
activate Presets or introduce automatic GitHub issue creation.

## Live original CLI smoke (isolated filesystem)

```sh
npm run build
node scripts/spec-kit-extras.smoke.mjs
./node_modules/.bin/tsx --test tests/spec-kit-extras.test.ts
```

The smoke verifies the upstream Git pin and all upstream tracked-file hashes,
reads official Artifact list/info/lookup and Bundle catalogs, and **actually
validates and installs both Bundles** with `uvx --offline` into separate
throwaway, non-Git directories. It checks their original component inventories,
no Preset, a missing-event no-op, and deletes both fixture directories even
on failure. It does not submit GitHub Issues, launch a workflow engine, edit
production configuration, restart MCP, or replay any browser chat turn.
This smoke is intentionally opt-in rather than part of portable `npm test`:
it needs a local verified official upstream checkout and `uvx`.
