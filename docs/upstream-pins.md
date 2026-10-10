# DevOS 2 — immutable upstream sources

This project pins the **unmodified originals** independently of custom
`devos-*` adaptations. Source of truth: `config/devos-upstreams.lock.json`.
Git repositories are cloned into the ignored staging cache, not copied into
Production or mixed with staging code. Licenses of both upstream projects
are MIT and remain in their original snapshots.

| Upstream | Release tag | Pinned peeled commit | Tracked files |
| --- | --- | --- | --- |
| github/spec-kit | v1.1.2 | `959e866caa3618bf3dc290d5dca33394365af9c6` | 897 |
| obra/superpowers | v6.4.2 | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` | 229 |

Tag references themselves are annotated Git objects; pins use the **peeled
commit**, not the tag object hash. Both full tracked snapshots also have
SHA-256 commitments. The digest hashes a sorted sequence of
`UTF-8 tracked path, NUL, SHA-256 file bytes, NUL`. The manifest additionally
lists individually hashed key commands/skills/extensions and license files.

From the project root (on the staging Mac):

```sh
node scripts/devos-upstreams.mjs install --root "$HOME/.devos-staging/upstream"
node scripts/devos-upstreams.mjs verify --root "$HOME/.devos-staging/upstream"
```

`install` clones each immutable tagged release into a temporary directory,
verifies the actual revision and every tracked file, then atomically moves
it to the target cache. It **never overwrites** an existing checkout;
untracked or modified files fail verification. `verify` is entirely offline.
Symlinks, unsafe manifest relative paths, wrong commits and changed bytes
fail closed. Directly invoking `node ... verify` avoids setup/installation.

Upgrading a pin requires a deliberate task, a diff against the previous
release, a new reviewed lockfile commit and testing of DevOS-adapted skills.
The original Spec Kit templates, scripts and skills must not be patched in
place. Upstream Superpowers skills must remain separate from DevOS forks.
Spec Kit CLI and specific native extensions will be installed and tested
in #125/#126; this task pins sources, not a functional SDD integration.
