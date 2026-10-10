# Provenance of devos-writing-plans

This is a **modified** copy/adaptation of
`obra/superpowers/skills/writing-plans/SKILL.md` from the immutable
`obra/superpowers` release `v6.4.2`, Git commit
`8ca22dba9a94f28898bbce59f2537ff4d87c747d`.

Original writing-plans/SKILL.md SHA-256:
`a6c67c1900064347c2a329990dd3c555657c51c3ec53b259a08aa01a2c26139a`

The original source, copyright notice and MIT License are preserved in
`~/.devos-staging/upstream/superpowers/` and
`config/devos-upstreams.lock.json`. Upstream copyright © Jesse Vincent;
adaptation for DevOS 2.

Adaptation changes (see `git diff --no-index` against original):
- Original Spec Kit `plan.md` and `tasks.md` remain the sole documents;
  removes separate Superpowers plan creation.
- Removes subagent/independent execution-method choices and Git/worktree
  ownership instructions.
- Keeps exact files, interfaces, small verifiable steps, test-first
  RED-GREEN-REFACTOR, failure conditions, self-review and DRY/YAGNI.
- Uses approvals already obtained during Main Agent planning; material
  new decisions go back to Main Agent, not to an in-flight worker.
