# Tasks: Main Agent wake-up
**Issue:** #224
**Status:** DRAFT; work unstarted; no original stage attestation

## Preparation
- [ ] T001 Verify original pinned Constitution and spec/plan, agree exact scope and full four-slot browser-first worker graph.
- [ ] T002 Pin this single PR, obtain authentic owner password-backed SHA/digest approval and sign four exact worker skill manifests/graph.

## Implement/test (browser developer first, local fallback only after genuine `needs_local_worker`)
- [ ] T003 RED tests: owner MCP session binds exact URL; distinguish `/c/` and `/share/`; reject ambiguous/revoked/other-owner chats.
- [ ] T004 RED tests: new final-review round yields one durable notification; retries, crashes and may-have-submitted never send again.
- [ ] T005 Implement owner wake-up in existing Camoufox task runtime and verify original private conversation from `/share/`; never post to public share copy.
- [ ] T006 RED/GREEN tests: unlimited explicit `changes_requested` rounds with same saved worker chats and one notification per round; `approved` closes runtime only afterward.
- [ ] T007 Run focused regressions, TypeScript build, applicable broader tests and live controlled browser E2E; preserve actual evidence.

## Independent review and handoff
- [ ] T008 Different predeclared reviewer verifies same PR, code, precise owner binding, idempotence, actual tests and authenticated MCP reporting.
- [ ] T009 On real defects return `changes_requested` to original developer/reviewer without starting a replacement Issue, PR or chat.
- [ ] T010 Runner returns trusted `FINAL_REVIEW_REQUIRED`; Main Agent independently checks original scope, PR, review, evidence and decides.

No checklist mark substitutes for real original `speckit` stage evidence or owner's authenticated task approval.

## Direct Main Agent repair follow-up (owner requested no Runner; #232 excluded)

- [x] T011 Safely resolve the owner wake-up destination from an **exact password-backed signed Issue/PR/Spec Kit review receipt** and currently approved chat fingerprint. Require a unique bound owner; revoked/multiple/foreign grants fail closed. A saved `/share/` remains a non-writable label, never a proof of editable `/c/`.
- [x] T012 RED/GREEN private durable exact owner+Issue+review-round wake-up ledger, atomic lease/arm BEFORE any Send, prompt+URL digests only, HMAC integrity, bounded expiry/cancellation, no restart replay after possible submit, provider-verifier-controlled confirmation, arbitrary new explicit review round.
- [ ] T013 Integrate with the exact `final_review_required` handoff and implement genuine shared Camoufox delivery: authenticate owner chat, navigate saved `/share/` to private editable `/c/`, verify same account/current owner bind, bounded busy/ready state, one real network user-message ID receipt per round. No fabricated completion from a click or model text.
- [ ] T014 Genuine two-chat headed authenticated E2E: busy Main Agent then released, single send, crash/restart/ambiguous turn, owner changes_requested loop and approved task-only close. Requires safe #226 live legacy-to-shared runtime adoption; no second profile/process.
- [ ] T015 Independent diff/security review plus full regression, Main Agent acceptance and PR merge/Issue close only if every original gate has actual evidence. #232 not touched.
- [x] T016 Integrate read-only unique signed owner task/PR lookup and durable notice enqueue AFTER Orchestrator saves mainAgentReviewPending, never from the earlier handoff event. Notification preparation errors are isolated from worker execution; all diagnostics say not_sent until real trusted delivery exists.
