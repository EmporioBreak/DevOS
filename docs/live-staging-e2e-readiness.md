# DevOS 2 — real Staging ChatGPT E2E readiness (#150)

Date: **2026-10-09**. This is a **partial LIVE probe with an explicit blocker**, not a completed feature, Bugfix or Assess E2E.

## Isolated source

- The copied, separate Mac **Staging** browser profile is at `~/.devos-staging/camoufox-profile`, not the Production profile. No Production session/profile/cookies or MCP process is opened, edited or restarted by these checks.
- Only the project-scoped ChatGPT URL from **Staging's** `.devos/config.json` is used. Scripts require `DEVOS_STAGING_ROOT` pointing to the dedicated checkout; they do not silently use another project's default.
- The independent Staging MCP on local port `8788` returned **health 200** during the browser checks. This does not establish remote plugin/iPhone trust.

## Observed real browser results

| Probe | Actual observation | Decision |
| --- | --- | --- |
| `tests/live-staging-chatgpt.smoke.ts` — read-only navigation using actual copied Camoufox profile | Camoufox launched; `https://chatgpt.com/` HTTPS origin; configured Project loaded; HTTP **200**; **no login redirect** or challenge; no user/worker message sent | **PASS (navigation only)** |
| `tests/live-staging-composer.smoke.ts` — read-only composer detection in the same staging Project | **Actual message editor visible**; send button not visible before entering text (not itself evidence of a defect); no message sent | **PASS (editor visibility only)** |
| `tests/live-browser-worker-transport.smoke.ts` — two benign ChatGPT QA turn plan, same exact Project conversation | The **first turn did not return a confirmed terminal result**; deadline, approximately **116.79 seconds**. It may have submitted. The script did not attempt the second turn. No authenticated original Spec Kit, DevOS worker grant or reviewer chain was exercised | **BLOCKED** |
| Local Staging one-shot guard | A private `.devos/qa/live-chatgpt-transport-20261009.json` records the ambiguous attempt. The smoke refuses later attempts with `one_shot_sentinel_present` **before browser launch or submit** | **PASS: no unsafe replay** |
| Production impact | No Production main, ngrok tunnel, active connector, browser profile, ChatGPT authorization store or cookies were intentionally changed | **No migration performed** |

**Uncertainty:** the first browser turn may have been submitted. `0 confirmed turns` must **never** be interpreted as `0 messages sent`. The exact new conversation URL was not persisted by the first smoke version, so no safe automatic resume is possible. The test now securely writes the URL on a future authorized one-shot attempt and records its intent before any irreversible submit. Do **not** remove the sentinel or re-run just to produce a green badge; investigate the specific prior turn through trusted read-only provider evidence or create a distinct explicitly authorized QA scenario.

## Safe replay of read-only checks

```sh
DEVOS_STAGING_ROOT=/path/to/DevOS-staging npx tsx tests/live-staging-chatgpt.smoke.ts
DEVOS_STAGING_ROOT=/path/to/DevOS-staging npx tsx tests/live-staging-composer.smoke.ts
```

The **message-sending** probe is purposefully opt-in and one-shot. The current date's marker exists after the real blocked attempt; invoking it again refuses to send anything:

```sh
DEVOS_STAGING_ROOT=/path/to/DevOS-staging npx tsx tests/live-browser-worker-transport.smoke.ts
# expected after recorded ambiguous attempt: one_shot_sentinel_present, exit 2
```

The runner's existing safe no-replay, task state and browser submit identity rules were separately tested in #146 and full automated regression #149. This live QA attempt itself does **not** establish saved URL continuity, original upstream skills actually invoked in ChatGPT, independent reviewer PR evidence, correct browser→Codex fallback, actual Spec Kit feature/bugfix/assess or Main Agent owner acceptance.

## Remaining actual #150 criteria

- Actual QA GitHub Issues and linked PRs with original feature/bugfix/assess artifacts, not a model-simulated workflow
- Browser-first developer/reviewer ChatGPT conversations with exact provider-verified saved URLs, correct graph/assigned original skills, changes_requested and Converge
- Genuine Codex fallback only after observed `needs_local_worker` and real host capability absence
- Main Agent independent final review, real host evidence and explicit owner decision, no auto-merge
- Staging OAuth plugin Web/iPhone acceptance (#151) and stress/recovery (#152)

Until those are demonstrated, keep #150 and Epic #121 **open**; no Production release (#154).

## QA contract defect found after the blocked attempt

The original first-turn probe asked ChatGPT to return only a bare marker. The browser executor's *conservative DOM fallback* only accepts a stable exact user message followed by a terminal assistant message ending with `DEVOS_RESULT {"status":"done"}`. Therefore the original QA prompt **could not use that recovery path**, even if ChatGPT had answered with its exact bare marker. The SSE path might still have worked, so this mismatch is a **proven test-design defect**, **not proof of the root cause of the actual deadline**.

The corrected future QA contract (separate helper in `tests/qa-transport-contract.ts`) asks for two exact lines: the unique test marker and the machine-valid final `DEVOS_RESULT`. Its standalone unit test checks valid and invalid responses without opening a browser or submitting a prompt. The old real attempt's one-shot sentinel remains untouched; this correction is **not license to replay the previous may-have-submitted message**. New genuinely independent QA scenarios must use unique identifiers and their own atomic intent record before any irreversible UI submit.

## Visible Camoufox mode — original DevOS 1 parity

A follow-up Mac process inspection found **no surviving task-owned Camoufox/Firefox or QA Node processes**. Production and Staging MCP listeners were deliberately kept running. The original DevOS 1 browser launcher, browser config, persistent-runtime and fingerprint code are **byte-identical to the Staging copies**. Both use `DEVOS_BROWSER_HEADLESS=0` by default.

The real problem with invisible QA windows was in the **ad-hoc live Staging smoke scripts**: they explicitly passed `headless:true` and the raw read-only probes independently generated `getRandomPreset()` on each launch, bypassing the persistent Camoufox identity. The live probes now use `tests/staging-headed-launch.ts` to delegate to the **actual DevOS 1 `chatGptBrowserDeps.loadIdentity` and `launchPersistentContext`**, using `DEVOS_BROWSER_HEADLESS=0` by default and the saved fingerprint. Set `DEVOS_BROWSER_HEADLESS=1` to hide the QA browser when desired; the worker transport probe honors the same setting. Neither mode is forbidden by tests. A new unit test verifies that configuration **without starting a browser**. Do not confuse this QA bug with a proven cause of the ChatGPT terminal-output timeout.

**No new browser/message was launched during this fix**, respecting the user's request to stop heavy tests. A future manual live Staging QA attempt should present a visible window, and still must not replay either previously ambiguous QA message or bypass its one-shot protection.

**Browser mode is user-configurable**, not locked by QA: `DEVOS_BROWSER_HEADLESS=0` (default, show window) or `DEVOS_BROWSER_HEADLESS=1` (headless). QA tests check both supported settings and reject only invalid values and scripts that bypass shared configuration.
