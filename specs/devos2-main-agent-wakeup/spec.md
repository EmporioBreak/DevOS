# Feature: wake the exact DevOS Main Agent chat
**Issue:** EmporioBreak/DevOS #224
**Branch:** devos2/main-agent-wakeup-224
**Status:** DRAFT — original Spec Kit stage not attested; exact graph/skill approval pending

## User story
As the DevOS owner I want DevOS Runner, after a real independent worker review, to wake the SAME authorized Main Agent ChatGPT conversation, so Main Agent checks the real Issue, PR and tests, and explicitly decides whether to approve or request changes.

## Requirements
- FR-001: Owner-chat binding derives exclusively from the previously password-approved Production MCP chat session and its MAC-protected registry. Do not choose an arbitrary one among multiple approved chats. Do not ask for another URL.
- FR-002: Accept either saved private `/c/` or saved `/share/` as the input. In an already logged-in Camoufox account, opening `/share/` may lead to the original private chat; verify the final URL and editable composer, or defer without sending.
- FR-003: One durable, exactly-once attempted send per distinct `FINAL_REVIEW_REQUIRED` round. Repeated status inspections and ambiguous post-Send failures must never cause blind re-send.
- FR-004: Sent content is clearly labeled automated DevOS notification (normal ChatGPT user-role turn), never trusted owner approval or forged system message.
- FR-005: Keep task status `final_review_required`, worker sessions and task browser while Main Agent is reviewing. Reuse the SAME worker chats and PR on `changes_requested`. Close the task browser only after genuine Runner `approved`.
- FR-006: Permit arbitrarily many explicitly authorized Main Agent revision rounds; still bound each attempt and prevent unbounded automatic retries.
- FR-007: Busy Main Agent turn, unavailable login, wrong conversation, revoked access, challenge or ambiguous submission => pending, without guessing destination or duplicating a possibly submitted turn.
- FR-008: No new worker role, Staging server, copied OAuth/profile, worktree, external daemon or silent default-owner binding.
