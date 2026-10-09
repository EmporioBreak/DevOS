# DevOS 2 — safe Issue pipeline timeline and skills attribution (#148)

`devos_pipeline_status({repo,issue})` is an owner-only, read-only
MCP tool that reports the task's bounded event timeline, current
worker/stage, signed skill versions and reasons for inclusion or
optional omission, review loops, final-review status and actionable
high-level blockers. It reuses the existing task state and Skills
Library registry; it **never opens a new browser**, fetches GitHub,
or starts an independent watcher.

The existing Runner `onEvent` callback stores a concise per-Issue
record in `.devos/logs/timeline/<encoded repo>-issue-<n>.jsonl`.
Record shape is deliberately fixed: timestamp, task number, event,
role/worker ID, lifecycle status, simple executor and first/resumed
session **type**. It stores **no** ChatGPT conversation URL,
OAuth credential, session token, hostname, prompt text, raw worker
response or raw host error. Recovery reasons are classified into
safe bounded categories. The journal retains at most **150 events**
and 128 KiB with atomic replacement under a short lock; there is
no background daemon/polling.

`readPipelineSnapshot` reads saved task state and this bounded
event log, and independently verifies assigned worker manifests
using the host owner secret. If a manifest is absent or tampered,
it returns `missing/invalid`, rather than inventing a skill.
If the key is unavailable, assignments are `unverified` and
their contents are **not** revealed. Structured reports include
selected ID/version/mode and exact configured precedence
(`global → project → role → task`), plus sanitized reasons for
optional skips. Reading corrupted events refuses unknown fields
rather than reproducing potentially sensitive injected data.

The MCP gateway restricts this owner timeline to **the currently
authorized individual owner chat**, not just OAuth client/bearer.
Browser worker grants **do not** permit reading the owner's
cross-task diagnostics. The real MCP SDK test confirms that a
separate ChatGPT conversation with the same OAuth credentials
still sees `authorization_required`, while an approved owner
chat can get a sanitized timeline.

This is a local task audit and owner-facing snapshot, **not** a
substitute for independently verifying GitHub worker reports or
the Main Agent acceptance checklist. The event log deliberately
does not claim that tests have actually run, that GitHub PR was
reviewed or that a browser worker completed its original skill
without provider evidence.

## Verification

```sh
npm run build
npx tsx --test tests/pipeline-diagnostics.test.ts
npx tsx --test --test-name-pattern='loopback HTTP refuses anonymous' tests/connector.test.ts
```

Tests cover an active final-review task, per-worker pin/skill-version,
skipped optional rules, bounded journal, sanitized malicious
recovery reason, tampered signed assignment, unknown JSON fields,
owner/no-key distinction, tool schema validation and cross-chat
MCP default-deny. Actual ChatGPT Web/iOS presentation is part of
#151, and final release review is #154.

Production logs, live ngrok, Camoufox profiles and OAuth state
are not changed by this PR.
