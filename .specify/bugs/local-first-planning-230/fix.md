# Original Spec Kit Bugfix — Fix (#230)

Replace only obsolete browser-first and Codex-fallback-only constraints in `taskGraph` with a reachability validation equivalent to the already merged `runner-skill-graph`. Preserve `parseWorkflow`, `owner.mode=main_agent`, independent reviewer checks, original contract Git pins and full graph digest binding. Keep the change minimal and scoped to the sole Production checkout on a normal branch with one Draft PR #231.

No new worker, profile, Staging connector, task resume, merge or live Production restart. Independent reviewer must decide from actual diff and tests; Main Agent remains final acceptor.
