# Technical assessment — Chat On Steroids → DevOS browser workers

**DevOS:** EmporioBreak/DevOS, Issue #239
**Compared revision:** CoS `totec448-spec/chat-on-steroids@9c9ccac195be282011a5e7c8f2ee35e64f8680b7` (MIT, 2026)
**Research environment:** clone into ephemeral `/tmp` only, no app install, no browser extension, no CoS credential access.
**Confidence:** source-level. Not a live claim about CoS's reliability, account permissions or current released binaries.

## Executive technical conclusion

**Adapt CoS's ownership/durability protocol; do not fork its whole Electron or Chrome extension into the existing Camoufox.** Existing DevOS is a task-signed Runner with local macOS/Desktop Commander MCP and Firefox/Camoufox, not an always-on Electron workspace with Chromium MV3. Two independent browser automation authorities would aggravate duplicate Send and profile corruption.

The highest-value shift is from **worker executor owns a page and submits a prompt** to **the project owns a durable browser command whose exact window/document/turn lease must be proved before every native action**. This would replace (rather than add beside) the existing in-memory IPC turn cache and the separate owner-notification send intent with one durable command/receipt owner.

### Verified upstream structural facts

1. CoS `src/main/agents.ts` acts as a broker with durable run incarnations, scoped family provenance, retained workers and inbox receipts. It has optional dynamic spawning, which DevOS must **not** import because DevOS signs a complete worker graph beforehand.
2. CoS `src/main/session/input.ts` maintains an authored outbox. It distinguishes queued text, browser claim, authorization, unconfirmed Send, provider user-message receipt and canonical history. The source explicitly forbids automatic replay after a claimed ambiguous Send.
3. CoS `src/main/bridge.ts` owns durable commands/leases/terminal receipts and command acknowledgement. Browser creation authority is spent at handout; a tab-listing error is not evidence that tabs are absent.
4. CoS `extension/background.js` has a bounded browser journal, page/document ownership, durable command ACK outbox, and resumption across MV3 worker suspension. The `content.js` and `fiber.js` halves observe the page; `chatgpt-dom.js` centralizes provider selectors.
5. CoS uses Chromium MV3 debugger/tabs capabilities with a separate loopback bridge. Camoufox Firefox persistent context is neither Chrome MV3 nor its host app. Direct code transplant is **not** a drop-in migration.
6. CoS's own `README.md`, `SECURITY.md` state browser automation/recording is **not a public ChatGPT automation API** and emphasize permitted use. MIT source licensing is not permission to override provider rules.
7. The source has a documented gap list (§21 of upstream `AGENTS.md`). This assessment does not assume CoS is bug-free.

### Where DevOS actually differs

| Concern | DevOS current (observed from main / active PRs) | Risk | CoS-derived remedy |
| --- | --- | --- | --- |
| Command durability | Main `SharedBrowserExecutor` in `src/shared-browser-runtime.ts` holds an IPC `turns` Map; Runner `src/orchestrator.ts` persists activeReport and session | Two authorities can disagree after process restart/ACK loss | Unify command lease and signed task state through one durable transaction |
| Browser process | Current #226 work introduces shared project process but old per-Issue detached Node runtimes are still alive | Old Node can relaunch Camoufox profile even with no native Firefox process | Retained legacy runtime ownership check and explicit quiesce/adopt transaction; never launch duplicate |
| Browser page identity | `ChatGptBrowserExecutor` tracks `workerPages` by worker ID; Playwright page may navigate/reload during waits | An async A→B→A event could satisfy a stale URL-only check | Document id + monotonic navigation epoch + process incarnation; revalidate at side-effect boundary |
| Completion | DOM and response reader attempt exact user-message recovery; post-submit ambiguity stops replay | Good defensive behavior but recovery and command state are split | Keep exact provider receipt; move it into same command ledger as browser action |
| Worker rework | DevOS saves worker conversation and signed MCP report, reviewers route same PR/chat | Preservation works while identity intact; browser lease not durable | Broker worker conversation independent of tab lifetime; chat and tab/command separate |
| Main Agent wake-up | #224 draft adds signed owner chat binding, separate per-round ledger; not real sender yet | Could become another competing outbox if directly grafted | One shared command/outbox with role-specific admission, exact owner grant and round |
| Browser recovery cleanup | In #226 branch (`src/chatgpt-browser-executor.ts`), `workerPages` is keyed by composite Issue+worker, but recovery cleanup still looks up bare `request.workerId` in two branches | Stale page ownership may survive a failure and later confuse reuse or cleanup | Add exact composite worker-key and current document epoch across EVERY recovery branch, with regression and no cross-Issue deletion |
| Real UI validation | Playwright DOM tests; MCP has no native screen/pointer tools | Green tests do not establish actual human-like GUI | Explicit evidence modality adapter and supervised headed E2E; no shell substitution |

### Deliberate DevOS worker-lifetime difference

CoS deliberately retains sleeping workers for future unrelated assignments. DevOS **does not**: the Main Agent holds the durable project history, while each worker and its ChatGPT conversation exist only for one GitHub Issue. Within an unfinished Issue, developer/reviewer can resume their **same** exact conversations on `changes_requested`. Once Main Agent has actually accepted and the Issue is verified closed as `completed`, the worker's task-bound grant and browser-tab ownership are retired, and the broker must **delete the actual owned worker conversations from ChatGPT account history** with exact account-level confirmation and idempotent durable cleanup; no future Issue can reuse or inherit their context. Historical signed reports, PR comments and code remain auditable and may be selectively summarized by Main Agent for a fresh worker; this is not worker-to-worker memory transfer. CoS's **durable outbox/tab-command protocol** is the inspiration; its **cross-task reusable sleeping-agent model is explicitly rejected**. The shared browser process/profile is a separate resource and may survive completed Issue A while Issue B continues.

### Four identities that must not collapse

```
DevOS signed task / approved graph
    └─ worker (stable: repo + Issue + worker ID)
       ├─ ChatGPT worker conversation (durable only within active Issue; delete from account after verified completion)
       ├─ browser command (unique command ID + exact worker turn)
       │   └─ claim (runtime incarnation + task window/tab + document/nav epoch)
       │      └─ provider user-message receipt (exact conversation + user ID)
       └─ signed MCP terminal worker report (distinct from browser send receipt)
```

One `workerId` alone cannot own a global page. One ChatGPT URL alone cannot authorize a local tool. A successful Playwright click alone cannot prove provider delivery. An MCP report cannot retrospectively authorize a duplicate browser send. A restarted process PID alone cannot own a profile.

### Suggested transport-neutral command contract

The contract below is an **architectural sketch**, not an existing production tool/schema:

```ts
type CommandIdentity = {
  projectRootId: string; repo: string; issue: number; workerId: string;
  runGraphDigest: string; workerTurn: number; commandId: string;
  destinationConversationId?: string;
  payloadSha256: string;
};
type BrowserClaim = {
  commandId: string; projectRuntimeIncarnation: string;
  taskWindowLease: string; workerTabLease: string;
  documentId: string; navigationEpoch: number;
};
type BrowserReceipt = {
  commandId: string; originalConversationId: string;
  providerUserMessageId: string; observedDocumentId: string;
};
type CommandPhase =
  | 'prepared' | 'claimed' | 'submitted_unconfirmed'
  | 'provider_confirmed' | 'provider_terminal'
  | 'cancelled_pre_submit' | 'blocked_ambiguous';
```

No one can call `claim` twice; after one successful claim, non-confirmed actions never automatically return to `prepared`. A known true pre-submit failure is a separate cryptographically/host-evidenced cancellation, never derived from the absence of a POST observer. A call can query its prior receipt by command ID; it cannot generate another submission. Late results must carry their original claim, not the tab's current URL/title. An A→B→A navigation with same URL is a different document/epoch.

### Owner-selected deletion of worker chats (not CoS sleeping workers)

The owner requires **actual removal of each completed Issue's DevOS-created worker conversation from ChatGPT account history**, rather than leaving it in the account for potential future reuse. This happens only after final Main Agent product approval and verified GitHub Issue closure as `completed` (and merge when applicable), after signed reports and required task audit evidence are secured. Broker—not the worker itself—first revokes all task-specific grants and active sends and then deletes only the exact locally owned provider conversation IDs using an authorized per-chat UI operation with its own durable claim, provider-level confirmation, and crash/ACK-loss reconciliation. Do not replace Delete with Archive, remove an entire Project, delete user/Main Agent conversations, or delete another Issue's chat. If deletion is unverified, report cleanup pending and preserve minimum protected receipt metadata without keeping entire transcripts. During changes_requested/rework, retain the original chats intact. An unresolved send must not be obliterated by cleanup. ChatGPT removal from the account is immediate on successful provider deletion, while OpenAI backend retention and 30-day scheduled deletion remain under provider policy, not within DevOS control.

This explicitly **replaces** the earlier research assumption “historical worker chat remains on account after Issue completion.” The authoritative long-term record is Main Agent + GitHub artifacts, not worker chat history.

### Parallel Issues are a DevOS core invariant, not a phase-two feature

The owner requires multiple separately approved GitHub Issues to progress **at the same time**, without Main Agent needing to remain online and without reusing worker contexts. This maps CoS's concurrent command handling to DevOS's distinct one-Issue signed graph instances: durable per-Issue scheduler slots, fair/bounded backpressure, task-specific worker chats and MCP grants, and exact windows/tabs inside **one** project Camoufox profile process. If B blocks awaiting ChatGPT, A and C still progress. Two simultaneous final-review events become independent durable notices serialized into the **single Main Agent chat**; no lost notification or false second `system` role. An accepted completed A triggers only A's irrevocable worker-chat deletion; B/C continue. The owner clarified that the earlier restriction was against abandoned worktree proliferation, not against properly tracked temporary per-Issue worktrees. Each concurrently active coding Issue may use ONE disposable, task-owned worktree/approved branch and edit/test in parallel. The single permanent Production checkout, connector, and Camoufox profile are shared and never multiplied. After independently verified Main Agent acceptance, PR merged and Issue closed `completed`, remove just that clean, quiesced, verified task worktree and the proven merged local feature branch; block and preserve dirty, unmerged, active or unverified trees. A durable owner ledger and crash-safe cleanup prevent orphan worktrees. Admission remains conditional on each exact Issue's signed owner-approved graph, not a generic autonomous swarm.

### Target repositories other than DevOS itself

DevOS is a **multi-project control plane**. The earlier wording “one Production checkout” described DevOS's own controller/deployment only; it must not imply all future software projects share that repository or location. Each target project independently registers its trusted Git remote/root, base branch, dedicated temporary worktree inventory, allowed tool permissions and broker-owned browser/chat scope. Two projects can both have Issue #42 and a `developer` worker without sharing a worktree, outgoing message owner, conversation or cleanup record. Each parallel target Issue gets one bounded disposable Git worktree in its own project; after Main Agent accepts and that target repo's PR is actually merged/Issue completed, DevOS removes only its registered clean task tree and verified merged feature branch. Crash-safe ownership reconciliation prevents abandoned managed worktrees; it must not delete unregistered/user-owned trees or assume that Git's global worktree list describes disposable DevOS resources. The controller's own Production checkout, connector and privileges remain single, with distinct project security boundaries. This is the required reusable DevOS product behavior, not a special repair only for repo `EmporioBreak/DevOS`.

### Migration order

1. Confirm exact original #226 signed browser turn and legacy PID ownership **without sending or terminating anything**. Produce read-only inventory before adoption.
2. Introduce protocol/identity conformance tests; initially RED in the old implementation.
3. Wire **one** authoritative command ledger into shared project runtime. Retire old per-process send caches, not run both as independent deliverers.
4. Wire document, window and worker-tab claims into Camoufox adapter. Cross-Issue data/account/MCP isolation probes must pass.
5. Route owner wake-up intents through this **same** outbox, preserving the #224 signed owner fingerprint and review-round identity.
6. Reconcile live legacy runtime only when it is positively safe. On ambiguity, stop new browser launch, preserve old saved chat and expose a precise blocker.
7. Run full real headed E2E + separate security review, then selective roll-out. Browser engine migration/Chromium extension option needs new owner/security approval and is not forced by this feature.

### Explicit things NOT to copy

- Electron UI/session-store as a second source of truth alongside DevOS.
- CoS runtime dynamic prime/worker spawning, **cross-Issue reusable/sleeping worker agents**, worker-to-worker free messaging or automatic account/model switching.
- Chrome debugger/MV3 extension, Chromium cookie transfer or account capture into the Firefox profile.
- Hidden/unbounded browser recovery, transcript scraping, undocumented provider API as a stable contract or any bypass for refused tool/usage access.
- A second persistent profile, Staging plugin, shadow Runner, global login daemon or new host-level watcher.

### Reuse and attribution

This assessment is independently written. It contains **no copied upstream code**; no MIT-licensed source files are currently imported. If a subsequent approved implementation copies or substantially adapts their code, include the upstream MIT license and required notice in that code's distribution with exact upstream commit provenance.

Primary references (pinned source):

- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/AGENTS.md
- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/src/main/session/input.ts
- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/src/main/bridge.ts
- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/src/main/agents.ts
- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/extension/background.js
- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/extension/content.js
- https://github.com/totec448-spec/chat-on-steroids/blob/9c9ccac195be282011a5e7c8f2ee35e64f8680b7/SECURITY.md

## Concrete source-review finding requiring a failing test

On existing PR #227 head `56c9de7`, `ChatGptBrowserExecutor.workerPages` keys are scoped by task and worker (e.g. `taskKey + '\0' + workerId`), but the catch/recovery branch still compares `this.workerPages.get(request.workerId)` and `this.workerPages.get('__default__')` at lines around 568–569. That inconsistency is a concrete cleanup bug candidate: a closed page may remain in the map under its composite key, while an unrelated task's page is unaffected. Because #226 has an active ambiguous submitted turn, **do not hot-patch the running production process or force a browser restart**. Reproduce with a harness for two Issues, one failed send, another Issue still running; fix through exact owner-scoped page claims after the approved rewrite.
