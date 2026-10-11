import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { profileProcesses, terminateOwnedBrowser, type OwnedBrowserProcess } from "./owned-browser-process.js";
import { readCompletedTurn, type SubmittedTurn } from "./chatgpt-turn-recovery.js";
import { mkdir } from "node:fs/promises";
import { Camoufox } from "@camoufox/camoufox";
import { loadOrCreateCamoufoxIdentity, type CamoufoxIdentity } from "./camoufox-identity.js";
import type { BrowserContext, Page, Request as PlaywrightRequest, Response as PlaywrightResponse } from "playwright-core";
import type { Executor, WorkerRequest } from "./executor.js";
import { debugLog } from "./debug-log.js";
import type { WorkerOutput } from "./workflow.js";
import {
  assertChatGptProjectScope,
  canonicalChatGptProjectId,
  getChatGptProjectScope,
  isProvisionalChatGptConversationId,
  loadChatGptBrowserConfig,
  validateChatGptUrl,
  type ChatGptBrowserConfig,
} from "./browser-config.js";
import { CHATGPT_RESPONSE_LOADER_SOURCE } from "./chatgpt-response-loader.js";
import { readExactDomFinal } from "./chatgpt-dom-recovery.js";
import { DevosToolRegistry } from "./mcp-tools/registry.js";
import { observeWorkerAuthorization } from "./chat-worker-observer.js";
import { localWorkerAuthorization } from "./chat-worker-grants.js";
import { classifyBrowserFailure, browserRecoveryDelayMs } from "./browser-recovery-policy.js";
import { BrowserCommandBroker } from "./browser-command-broker.js";
import type { BrowserDocumentClaim } from "./browser-command-identity.js";

export class BrowserResumeUnavailableError extends Error {
  constructor(readonly sessionId: string, message: string) {
    super(message);
    this.name = "BrowserResumeUnavailableError";
  }
}

class BrowserCommandReplayError extends Error {
  constructor() {
    super("Browser command was already claimed; refusing a second Send");
    this.name = "BrowserCommandReplayError";
  }
}

export function isBrowserResumeUnavailableError(
  error: unknown,
): error is BrowserResumeUnavailableError {
  return error instanceof BrowserResumeUnavailableError;
}

export class BrowserPreSubmitFailureError extends Error {
  readonly safeToRetryFresh = true;

  constructor(message: string) {
    super(message);
    this.name = "BrowserPreSubmitFailureError";
  }
}

export function isBrowserPreSubmitFailureError(
  error: unknown,
): error is BrowserPreSubmitFailureError {
  return error instanceof BrowserPreSubmitFailureError;
}

const COMPOSER = [
  '[data-testid="prompt-textarea"]:visible',
  '#prompt-textarea:visible',
  'textarea[placeholder*="Message"]:visible',
  '[contenteditable="true"]:visible',
].join(",");

const SEND = [
  '#composer-submit-button:visible',
  'button[data-testid="send-button"]:visible',
  'button[aria-label*="Send"]:visible',
  'button[type="submit"][aria-label="Отправить"]:visible',
].join(",");

export const chatGptBrowserDeps = {
  loadIdentity: loadOrCreateCamoufoxIdentity,
  launchPersistentContext: (
    profileDir: string,
    options: {
      headless: boolean;
      timeout: number;
      identity: CamoufoxIdentity;
    },
  ): Promise<BrowserContext> =>
    Camoufox({
      user_data_dir: profileDir,
      persistent_context: true,
      fingerprint_preset: options.identity.preset,
      headless: options.headless,
      timeout: options.timeout,
      firefox_user_prefs: {
        "browser.link.open_newwindow": 3,
        "browser.link.open_newwindow.restriction": 0,
      },
    }),
};

export class ChatGptBrowserExecutor implements Executor {
  readonly kind = "chatgpt_browser" as const;
  private context: BrowserContext | undefined;
  private ownedProcess: OwnedBrowserProcess | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private readonly workerPages = new Map<string, Page>();
  private readonly documentEpochs = new WeakMap<Page, { documentId: string; navigationEpoch: number }>();
  private readonly runtimeIncarnation = randomUUID();

  constructor(
    private readonly config: ChatGptBrowserConfig = loadChatGptBrowserConfig(),
    private readonly timeoutMs = 60 * 60_000,
    private readonly onOwnedBrowserProcess?: (owned: OwnedBrowserProcess) => Promise<void>,
    private readonly commandBroker?: BrowserCommandBroker,
  ) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    return await this.runTurn(request);
  }

  private trackDocument(page: Page): { documentId: string; navigationEpoch: number } {
    let state = this.documentEpochs.get(page);
    if (state) return state;
    state = { documentId: randomUUID(), navigationEpoch: 0 };
    this.documentEpochs.set(page, state);
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) {
        state!.documentId = randomUUID();
        state!.navigationEpoch++;
      }
    });
    return state;
  }

  private async claimBrowserCommand(request: WorkerRequest, page: Page): Promise<BrowserDocumentClaim | undefined> {
    if (!this.commandBroker) return undefined;
    const context = request.browserCommand;
    if (!context || !request.workerId || context.workerId !== request.workerId ||
        !context.task || !Number.isSafeInteger(context.turn) || context.turn < 1 ||
        (request.reportTurn && (request.reportTurn.task.repo !== context.task.repo ||
          request.reportTurn.task.issue !== context.task.issue ||
          request.reportTurn.active.workerId !== context.workerId ||
          request.reportTurn.active.turn !== context.turn)))
      throw new Error("Trusted browser command identity is missing or inconsistent");
    const document = this.trackDocument(page);
    const url = new URL(page.url());
    const conversation = /\/c\/([^/?#]+)/.exec(url.pathname)?.[1];
    const payloadSha256 = createHash("sha256").update(request.prompt).digest("hex");
    const taskKey = `${context.task.repo}#${context.task.issue}`;
    const claim: BrowserDocumentClaim = {
      repo: context.task.repo, issue: context.task.issue, workerId: context.workerId,
      turn: context.turn, commandId: context.commandId, runtimeIncarnation: this.runtimeIncarnation,
      profileOwner: createHash("sha256").update(resolve(this.config.profileDir)).digest("hex"),
      windowLease: createHash("sha256").update(taskKey).digest("hex"),
      tabLease: createHash("sha256").update(`${taskKey}#${context.workerId}`).digest("hex"),
      documentId: document.documentId, navigationEpoch: document.navigationEpoch,
      conversationId: conversation ? decodeURIComponent(conversation) : undefined, payloadSha256,
    };
    await this.commandBroker.prepare(claim);
    if (!(await this.commandBroker.claim(claim.commandId, claim))) throw new BrowserCommandReplayError();
    return claim;
  }

  private async requireCommandReceipt(
    claim: BrowserDocumentClaim | undefined,
    receiptWrite: Promise<void> | undefined,
  ): Promise<void> {
    if (!claim || !this.commandBroker) return;
    await receiptWrite;
    const record = await this.commandBroker.get(claim.commandId);
    if (record?.status === "claimed") await this.commandBroker.markAmbiguous(claim.commandId);
    if (record?.status !== "acknowledged")
      throw new Error("Browser command has no exact acknowledged provider receipt; replay is prohibited");
  }

  private async runTurn(request: WorkerRequest): Promise<WorkerOutput> {
    const projectScope = request.enforceProjectScope
      ? getChatGptProjectScope(this.config.projectUrl)
      : null;
    const url = request.sessionId ?? this.config.projectUrl;
    // Invalid saved identity/configuration is definitive, before any navigation.
    validateChatGptUrl(url);
    if (projectScope && request.sessionId) {
      assertChatGptProjectScope(this.config.projectUrl, request.sessionId, true);
    }
    debugLog("browser.session", { decision: request.sessionId ? "resume" : "fresh", requestedUrl: url, projectRoot: request.projectRoot });
    const {
      page,
      prepared: preparedMessage,
      getBackendFailure,
      detachBackendListener,
    } = await this.prepare(request, !!projectScope);
    let mayHaveSubmitted = false;
    let submitted: SubmittedTurn | undefined;
    let submissionAmbiguous = false;
    let submittedRequest: PlaywrightRequest | undefined;
    let claimedCommand: BrowserDocumentClaim | undefined;
    let providerReceiptWrite: Promise<void> | undefined;
    let durableSession = request.sessionId;
    // The terminal MCP tool is the control plane: receipt of its authenticated,
    // turn-scoped report can finish this run even if the SSE observer hangs.
    const reportAbort = request.reportTurn ? new AbortController() : undefined;
    const rememberSession = async (session: string) => {
      if (durableSession && !isSameChatGptConversation(durableSession, session)) throw new Error("ChatGPT changed conversation identity");
      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, session, true);
      durableSession = session;
      await request.onSession?.(session);
    };
    // Local-only authorization observer: the Page's structured provider tool
    // result is checked against the exact saved worker URL and active turn.
    // It never enters model-visible context or grants based on prompt strings.
    if (request.reportTurn && request.workerId && reportAbort) {
      void observeWorkerAuthorization({
        page, root: request.projectRoot, task: request.reportTurn.task,
        workerId: request.workerId, turn: request.reportTurn.active.turn,
        expectedConversation: () => durableSession,
        expectedUserMessageId: () => submitted?.messageId,
        exactSubmittedPrompt: request.prompt,
        signal: reportAbort.signal,
      }).catch(() => {
        debugLog("browser.worker-access", { phase: "observer", decision: "unavailable" });
      });
    }
    const onOutgoingRequest = (outgoing: PlaywrightRequest) => {
      if (!mayHaveSubmitted) return;
      try {
        const target = new URL(outgoing.url());
        if (target.origin !== new URL(url).origin || !/^\/backend-api\/(?:f\/)?conversation\/?$/.test(target.pathname) || outgoing.method() !== "POST") return;
        const payload: unknown = outgoing.postDataJSON();
        const candidate = extractSubmittedTurn(payload, request.prompt);
        debugLog("browser.submission.shape", conversationRequestShape(payload));
        if (!candidate || submitted) {
          if (submitted) submissionAmbiguous = true;
          // Missing/inaccessible identity in the network observer is not proof
          // of a conflicting request: the exact-prompt page-world fetch
          // interceptor can still independently supply the single ID.
          debugLog("browser.submission", { phase: "post-submit", captured: false, reason: submitted ? "duplicate conversation POST" : "request identity unavailable" });
          return;
        }
        submitted = candidate;
        submittedRequest = outgoing;
        // Log only whether identifiers are present; never persist prompt, IDs,
        // OAuth headers or a raw request payload in diagnostics.
        debugLog("browser.submission", { phase: "post-submit", captured: true, hasConversationId: !!submitted.conversationId, hasMessageId: true });
      } catch {
        // No known identity; conservative page-world capture may still supply
        // exact-prompt proof. Never infer an ID from arbitrary final text.
        debugLog("browser.submission", { phase: "post-submit", captured: false, reason: "request payload unavailable" });
      }
    };
    const onOutgoingResponse = (response: PlaywrightResponse) => {
      if (!this.commandBroker || !claimedCommand || !submittedRequest ||
          response.request() !== submittedRequest) return;
      if (response.status() < 200 || response.status() >= 300 || !submitted?.conversationId) {
        debugLog("browser.command.receipt", { decision: "ambiguous-provider-response", status: response.status() });
        return;
      }
      const receipt = {
        repo: claimedCommand.repo, issue: claimedCommand.issue,
        workerId: claimedCommand.workerId, turn: claimedCommand.turn,
        commandId: claimedCommand.commandId, payloadSha256: claimedCommand.payloadSha256,
        conversationId: submitted.conversationId, messageId: submitted.messageId,
      };
      providerReceiptWrite = (async () => {
        await this.commandBroker!.recordProviderReceipt(claimedCommand!.commandId, receipt);
        await this.commandBroker!.acknowledge(claimedCommand!.commandId, receipt);
      })();
    };
    page.on("request", onOutgoingRequest);
    page.on("response", onOutgoingResponse);
    try {
      let submissionStarted!: () => void;
      const submission = new Promise<void>(resolve => { submissionStarted = resolve; });
      const assertSubmissionScope = async () => {
        try {
          const backendFailure = getBackendFailure();
          if (backendFailure) throw backendFailure;
          if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), request.sessionId !== undefined);
          if (request.sessionId && !isSameChatGptConversation(request.sessionId, page.url())) throw new Error("ChatGPT changed saved conversation before submission");
          claimedCommand = await this.claimBrowserCommand(request, page);
          mayHaveSubmitted = true;
          submissionStarted();
        } catch (error) {
          if (error instanceof BrowserCommandReplayError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (request.sessionId) throw new BrowserResumeUnavailableError(request.sessionId, message);
          throw new BrowserPreSubmitFailureError(message);
        }
      };
      // MCP worker status is the only normal completion signal. Submit once
      // and never parse UI/DOM/SSE final text for these turns.
      const streamResponse = request.reportTurn
        ? submitOnly(page, request.prompt, this.timeoutMs, assertSubmissionScope, preparedMessage)
            .then(() => new Promise<never>(() => {}), error => ({ error } as const))
        : sendAndRead(page, request.prompt, this.timeoutMs, assertSubmissionScope, preparedMessage).then(
            text => ({ text } as const), error => ({ error } as const),
          );
      const response = request.reportTurn && reportAbort
        ? Promise.race([
            streamResponse,
            new DevosToolRegistry(request.projectRoot).waitForReport(
              request.reportTurn.task, request.reportTurn.active, reportAbort.signal,
            ).then(status => {
              debugLog("browser.report", { workerId: request.workerId, turn: request.reportTurn!.active.turn, status, decision: "mcp-terminal" });
              // Settle the old Playwright waiter without altering the ChatGPT
              // network request or UI. Guard by token so it cannot affect a
              // newly armed turn on this same page.
              void page.evaluate(({ token }) => {
                const state = (window as unknown as {
                  __DEVOS_STREAM_STATE__?: { request: number; text: string | null; failed: boolean };
                }).__DEVOS_STREAM_STATE__;
                if (state && state.request === token && state.text === null) state.failed = true;
              }, { token: preparedMessage.token }).catch(() => undefined);
              return { text: "" } as const;
            }),
          ])
        : streamResponse;

      if (request.sessionId) {
        const outcome = await response;
        if ("error" in outcome) throw outcome.error;
        await this.requireCommandReceipt(claimedCommand, providerReceiptWrite);
        if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), true);
        if (!isSameChatGptConversation(request.sessionId, page.url())) throw new Error("ChatGPT changed saved conversation after submission");
        debugLog("browser.session.ready", { sessionId: request.sessionId, actualUrl: page.url() });
        await rememberSession(request.sessionId);
        debugLog("browser.response", { sessionId: request.sessionId, textLength: outcome.text.length });
        return { text: outcome.text, sessionId: request.sessionId };
      }

      // Surface preparation failures before starting URL discovery. After submission,
      // preserve a created session even when response loading has already failed.
      const prepared = await Promise.race([submission, response]);
      if (prepared && "error" in prepared) throw prepared.error;
      const sessionId = await waitForConversationUrl(
        page, Math.min(this.timeoutMs, 5 * 60_000),
        projectScope ? this.config.projectUrl : undefined,
      );

      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, sessionId, true);
      debugLog("browser.session.ready", { sessionId, actualUrl: page.url() });
      await rememberSession(sessionId);

      const outcome = await response;
      if ("error" in outcome) throw outcome.error;
      await this.requireCommandReceipt(claimedCommand, providerReceiptWrite);
      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), true);
      if (!isSameChatGptConversation(sessionId, page.url())) throw new Error("ChatGPT changed fresh conversation after submission");
      debugLog("browser.response", { sessionId, textLength: outcome.text.length });
      return { text: outcome.text, sessionId };
    } catch (error) {
      const cause = error instanceof Error ? error.message.split("\n")[0]! : "Browser operation failed";
      if (mayHaveSubmitted) {
        await providerReceiptWrite?.catch(() => undefined);
        const commandRecord = claimedCommand ? await this.commandBroker?.get(claimedCommand.commandId).catch(() => null) : null;
        if (commandRecord?.status === "claimed") await this.commandBroker?.markAmbiguous(claimedCommand!.commandId).catch(() => undefined);
        // Optional read-only DOM evidence: one exact submitted user turn and
        // one stable assistant final bearing a machine-valid DEVOS_RESULT.
        // This does not depend on outgoing network user IDs or extra MCP calls.
        // Only evaluate it on the verified saved Project conversation.
        if (durableSession && isSameChatGptConversation(durableSession, page.url())) {
          const domFinal = await readExactDomFinal(page, request.prompt, Math.min(this.timeoutMs, 3_000));
          if (domFinal) {
            await this.requireCommandReceipt(claimedCommand, providerReceiptWrite);
            debugLog("browser.recovery", { phase: "post-submit", decision: "exact-dom-final" });
            return { text: domFinal, sessionId: durableSession };
          }
        }
        // A page-world Request/fetch interceptor may see the exact outgoing
        // user identity even when the Playwright network observer misses it.
        // It is still anchored to this armed turn and the exact prompt.
        if (!submitted && !submissionAmbiguous) {
          const captured = await page.evaluate(({ token }) => {
            const state = (window as unknown as {
              __DEVOS_STREAM_STATE__?: {
                request: number; messageId: string | null; conversationId: string | null;
              };
            }).__DEVOS_STREAM_STATE__;
            if (state?.request !== token) return null;
            return { messageId: state.messageId, conversationId: state.conversationId };
          }, { token: preparedMessage.token }).catch(() => null);
          if (captured && typeof captured.messageId === "string" &&
              captured.messageId.length > 0 && captured.messageId.length <= 200) {
            submitted = {
              messageId: captured.messageId,
              ...(typeof captured.conversationId === "string" &&
                captured.conversationId.length <= 200 ? { conversationId: captured.conversationId } : {}),
            };
          }
        }
        debugLog("browser.recovery", { attempt: 1, phase: "post-submit", sessionId: durableSession, captured: !!submitted && !submissionAmbiguous, decision: "reload/read-only" });
        try {
          if (!submitted || submissionAmbiguous || !durableSession) throw new Error("submitted user/conversation identity absent or ambiguous");
          const conversationId = /\/c\/([^/?#]+)/.exec(new URL(durableSession).pathname)?.[1];
          if (!conversationId || (submitted.conversationId && submitted.conversationId !== conversationId)) throw new Error("submitted conversation identity changed");
          // An observed identity change is definitive; never follow it or mask it.
          if (!isSameChatGptConversation(durableSession, page.url())) throw new Error("actual conversation identity changed");
          await rememberSession(durableSession);
          const text = await this.recoverTurn(request, durableSession, conversationId, submitted);
          return { text, sessionId: durableSession };
        } catch (recoveryError) {
          const reason = recoveryError instanceof Error ? recoveryError.message.split("\n")[0]! : "read unavailable";
          debugLog("browser.recovery", { attempt: 1, phase: "post-submit", sessionId: durableSession, decision: "stopped-ambiguous", submittedMessageId: submitted?.messageId, reason });
          throw new Error(`Browser recovery attempt=1 phase=post-submit: prompt not replayed; saved identity preserved (conversation=${durableSession ?? "unknown"}, user-message=${submitted?.messageId ?? "unknown"}); ${cause}; read-only recovery: ${reason}`);
        }
      }
      throw error;
    } finally {
      reportAbort?.abort();
      // Revoke on normal completion, cancellation or a caught failure.
      // Abrupt process loss is additionally bounded by the grant expiry and
      // requires task state validation on every forwarded operation.
      if (request.reportTurn && request.workerId) {
        try {
          localWorkerAuthorization(request.projectRoot)?.registry.revoke(
            request.reportTurn.task, request.workerId,
          );
        } catch {
          debugLog("browser.worker-access", { phase: "revoke", decision: "failed-closed-by-task-state" });
        }
      }
      detachBackendListener();
      // Keep only one request listener per active worker turn across repeated
      // use of the same tab, including MCP-finished turns.
      page.off?.("request", onOutgoingRequest);
      page.off?.("response", onOutgoingResponse);
      // Stable worker pages stay alive for the whole task. Cleanup is task-scoped.
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    const owned = this.ownedProcess;
    if (!context && !owned) return;
    debugLog("browser.cleanup", { phase: "context", decision: "closing" });
    let confirmed = false;
    if (context) {
      try {
        await closeBeforeDeadline(async () => {
          await context.close();
          confirmed = true;
        }, Date.now() + Math.min(this.timeoutMs, 5_000));
      } catch {
        // Playwright may disconnect while Camoufox is still alive. A captured,
        // exact-profile process identity is the only safe fallback target.
      }
    }
    if (owned) {
      // context.close() completing does NOT prove that the native Firefox root
      // and its event loop have exited. Wait briefly, then terminate only the
      // exact root created for our private profile.
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        const active = (await profileProcesses(this.config.profileDir))
          .some(process => process.pid === owned.pid && process.identity === owned.identity);
        if (!active) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const stillAlive = (await profileProcesses(this.config.profileDir))
        .some(process => process.pid === owned.pid && process.identity === owned.identity);
      if (stillAlive) {
        debugLog("browser.cleanup", { phase: "context", decision: "terminate-owned-process" });
        confirmed = await terminateOwnedBrowser(owned, this.config.profileDir);
      } else {
        confirmed = true;
      }
    }
    if (!confirmed) {
      debugLog("browser.cleanup", { phase: "context", decision: "unconfirmed" });
      throw new Error("Browser cleanup unconfirmed: exact owned process termination not verified");
    }
    if (this.context === context) { this.context = undefined; this.workerPages.clear(); }
    if (this.ownedProcess === owned) this.ownedProcess = undefined;
    debugLog("browser.cleanup", { phase: "context", decision: "closed" });
  }

  private async prepare(
    request: WorkerRequest,
    enforceScope: boolean,
  ): Promise<{
    page: Page;
    prepared: PreparedMessage;
    getBackendFailure: () => Error | undefined;
    detachBackendListener: () => void;
  }> {
    const url = request.sessionId ?? this.config.projectUrl;
    const deadline = Date.now() + Math.min(this.timeoutMs, 45_000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let page: Page | undefined;
      let phase = "context";
      let expired = false;
      let timedOut = false;
      let backendFailure: Error | undefined;
      let detachBackendListener = () => {};
      const budget = Math.min(15_000, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (budget <= 0) throw new Error("Timeout: preparation deadline exhausted");
        const preparation = async () => {
          const context = await this.getContext(budget, !request.reportTurn);
          if (expired) { await this.close(); throw new Error("Timeout: preparation deadline exhausted"); }
          phase = "new-page";
          page = await this.getWorkerPage(request, context);
          if (expired) { await page.close(); throw new Error("Timeout: preparation deadline exhausted"); }
          const currentPage = page;
          if (this.commandBroker) this.trackDocument(currentPage);
          const onBackendResponse = (response: PlaywrightResponse) => {
            const target = new URL(response.url());
            const status = response.status();
            if (target.origin === new URL(url).origin && target.pathname.startsWith("/backend-api/") && (status >= 500 || status === 408 || status === 425)) backendFailure = new Error(`Transient backend HTTP ${status}`);
            if (target.origin === new URL(url).origin && target.pathname.startsWith("/backend-api/") && (status === 401 || status === 403)) {
              const headers = response.headers();
              const challenge = status === 403 && (headers["cf-mitigated"] === "challenge" ||
                (headers["content-type"] ?? "").includes("text/html"));
              backendFailure = new Error(`ChatGPT ${challenge ? "authentication/challenge" : "authentication/access"} blocked backend (HTTP ${status})${status === 401 ? "; visible login/debug run needed (DEVOS_BROWSER_HEADLESS=0)" : ""}`);
            }
            if (target.origin === new URL(url).origin && target.pathname.startsWith("/backend-api/") && status === 429)
              backendFailure = new Error("ChatGPT provider rate limit HTTP 429");
          };
          currentPage.on("response", onBackendResponse);
          detachBackendListener = () => { currentPage.off?.("response", onBackendResponse); };
          phase = "navigation";
          const response = await currentPage.goto(url, { waitUntil: "domcontentloaded", timeout: budget });
          if (expired) throw new Error("Timeout: preparation deadline exhausted");
          debugLog("browser.navigation", { requestedUrl: url, actualUrl: currentPage.url(), attempt });
          const status = response?.status();
          if (status === 401 || status === 403) {
            const headers = response?.headers?.() ?? {};
            if (status === 403 && (headers["cf-mitigated"] === "challenge" ||
                (headers["content-type"] ?? "").includes("text/html"))) {
              // An HTML 403 can be a manual verification page. Never refresh
              // away a CAPTCHA the owner is actively being asked to solve.
              const interstitial = await currentPage.evaluate(() =>
                (document.body?.innerText ?? "").slice(0, 2000)).catch(() => "");
              if (/verify you are human|captcha|turnstile|провер.*человек/i.test(interstitial))
                throw new Error("ChatGPT interactive challenge: Verify you are human");
              throw new Error(`Temporary ChatGPT interstitial HTTP ${status}`);
            }
            throw new Error(`ChatGPT authentication/access blocked navigation (HTTP ${status})`);
          }
          if (status === 404 || status === 410) throw new Error(`ChatGPT conversation unavailable (HTTP ${status})`);
          if (status && (status >= 500 || status === 408 || status === 425)) throw new Error(`Transient navigation HTTP ${status}`);
          if (status && status >= 400) throw new Error(`ChatGPT navigation rejected (HTTP ${status})`);
          phase = "page-state";
          const body = await currentPage.evaluate(() => {
            // Conversation history can discuss login/challenge errors. Only
            // classify actual page surfaces, never text from earlier turns.
            const turns = '[data-message-author-role], [data-testid^="conversation-turn"]';
            const login = Array.from(document.querySelectorAll('a[href*="/auth/login"], a[href*="/auth/signin"], [data-testid="login-button"]'))
              .some(node => !node.closest(turns) && (node as HTMLElement).getClientRects().length > 0);
            if (login) return "DEVOS_SIGNED_OUT";
            if (!document.querySelector(turns)) return document.body?.innerText ?? "";
            return Array.from(document.querySelectorAll('[role="alert"], [role="dialog"], main h1, main h2'))
              .filter(node => !node.closest(turns))
              .map(node => (node as HTMLElement).innerText ?? "").join("\n");
          });
          if (typeof body === "string") {
            if (/verify you are human|captcha|turnstile|провер.*человек/i.test(body)) throw new Error("ChatGPT interactive challenge: Verify you are human");
            if (/cloudflare|just a moment|checking your browser/i.test(body)) throw new Error("ChatGPT passive challenge page");
            if (/unable to load conversation|conversation (?:not found|unavailable)|не удалось загрузить (?:разговор|чат)/i.test(body)) throw new Error("ChatGPT conversation unavailable");
            if (/DEVOS_SIGNED_OUT|log in to chatgpt|sign in to chatgpt|необходимо войти/i.test(body)) throw new Error("ChatGPT authentication required; visible login/debug run needed (DEVOS_BROWSER_HEADLESS=0)");
          }
          const actual = validateChatGptUrl(currentPage.url());
          if (/^\/(?:auth|login|signin)(?:\/|$)/i.test(actual.pathname)) throw new Error("ChatGPT authentication required; visible login/debug run needed (DEVOS_BROWSER_HEADLESS=0)");
          // A root redirect without a composer can be transient during account
          // loading. Other wrong routes/scopes are definitive before waiting.
          const rootRedirect = enforceScope && actual.pathname === "/";
          if (!rootRedirect) this.assertIdentity(request, currentPage, enforceScope);
          phase = rootRedirect ? "account-loading" : "composer";
          if (backendFailure) throw backendFailure;
          try {
            await currentPage.locator(COMPOSER).first().waitFor({ state: "visible", timeout: budget });
          } catch (error) {
            throw backendFailure ?? error;
          }
          if (backendFailure) throw backendFailure;
          this.assertIdentity(request, currentPage, enforceScope);
          phase = "prepare-message";
          if (expired) throw new Error("Timeout: preparation deadline exhausted");
          const prepared = await prepareMessage(currentPage, request.prompt, budget, !request.reportTurn);
          if (backendFailure) throw backendFailure;
          this.assertIdentity(request, currentPage, enforceScope);
          return {
            page: currentPage,
            prepared,
            getBackendFailure: () => backendFailure,
            detachBackendListener,
          };
        };
        const outcome = await Promise.race([
          preparation(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => {
            expired = true; timedOut = true; reject(new Error("Timeout: preparation deadline exhausted"));
          }, budget); }),
        ]);
        debugLog("browser.recovery", { attempt, phase, decision: "ready", requestedUrl: url });
        return outcome;
      } catch (error) {
        expired = true;
        detachBackendListener();
        // A server transport notice must not override a definite identity
        // violation, account refusal, or visible human verification screen.
        const pageDecision = classifyBrowserFailure(error);
        const effectiveError = pageDecision.action === "human" ||
          ["identity_or_access", "provider_denial"].includes(pageDecision.reason)
          ? error : backendFailure ?? error;
        const cause = effectiveError instanceof Error ? effectiveError.message.split("\n")[0]! : "Browser operation failed";
        const disposition = classifyBrowserFailure(effectiveError);
        const transient = disposition.action === "retry";
        // A wall-clock race leaves an unsettled Playwright operation: close
        // its tab and defer further work to a new explicit Runner invocation.
        const retry = transient && !timedOut && attempt < 3 && Date.now() < deadline;
        const broken = /closed|crashed|disconnected/i.test(cause);
        // Keep a surviving tab for retries and interactive checks. Reloading the
        // same tab preserves signed-in state and permits the human to see a check.
        // A raced operation may still be running after the wall-clock timeout.
        // Close its page before any next attempt; never run two navigations on it.
        if (broken || timedOut || disposition.action === "stop") {
          await closeBeforeDeadline(() => page?.close() ?? Promise.resolve(), deadline);
          if (page && request.workerId && this.workerPages.get(request.workerId) === page) this.workerPages.delete(request.workerId);
          if (page && !request.workerId && this.workerPages.get("__default__") === page) this.workerPages.delete("__default__");
        }
        if (broken) await closeBeforeDeadline(() => this.close(), deadline);
        debugLog("browser.recovery", { attempt, phase, category: disposition.reason,
          requestedUrl: url, actualUrl: page?.url(),
          decision: retry ? "reload-same-tab" : disposition.action === "human" ? "wait-for-human" : "stop" });
        if (retry) {
          const pause = deadline - Date.now() > 5_000 ? browserRecoveryDelayMs(attempt, deadline - Date.now()) : 0;
          if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
        }
        if (!retry) {
          const message = `Browser recovery attempt=${attempt} phase=${phase} ${transient ? "transient" : "definitive"} (${disposition.reason}): ${cause}; saved identity preserved`;
          if (request.sessionId) throw new BrowserResumeUnavailableError(request.sessionId, message);
          throw new BrowserPreSubmitFailureError(message);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error("Browser preparation exhausted");
  }

  private async recoverTurn(
    request: WorkerRequest,
    session: string,
    conversationId: string,
    turn: SubmittedTurn,
  ): Promise<string> {
    const deadline = Date.now() + Math.min(this.timeoutMs, 3 * 60_000);
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      const budget = Math.min(15_000, deadline - Date.now());
      try {
        const observe = async () => {
          if (this.context?.pages?.().every(candidate => candidate.isClosed())) await this.close();
          const context = await this.getContext(budget, !request.reportTurn);
          if (expired) throw new Error("Timeout: read-only recovery deadline exhausted");
          const page = await this.getWorkerPage(request, context);
          if (expired) throw new Error("Timeout: read-only recovery deadline exhausted");
          // Listen before navigating; the authenticated frontend performs the read.
          const read = page.waitForResponse(response => {
            const target = new URL(response.url());
            return target.origin === new URL(session).origin && target.pathname === `/backend-api/conversations/${conversationId}`;
          }, { timeout: budget });
          void read.catch(() => undefined);
          const navigation = await page.goto(session, { waitUntil: "domcontentloaded", timeout: budget });
          if (expired) throw new Error("Timeout: read-only recovery deadline exhausted");
          if (!isSameChatGptConversation(session, page.url())) throw new Error("Recovery conversation identity changed");
          const status = navigation?.status() ?? 200;
          if (status >= 500) throw new Error(`Transient navigation HTTP ${status}`);
          if (status >= 400) throw new Error(`Recovery navigation unavailable HTTP ${status}`);
          const response = await read;
          if (response.status() >= 500) throw new Error(`Transient navigation HTTP ${response.status()}`);
          if (response.status() !== 200) throw new Error(`Recovery read unavailable HTTP ${response.status()}`);
          const data: unknown = await response.json().catch(() => { throw new Error("Recovery conversation data is not structured JSON"); });
          if (expired) throw new Error("Timeout: read-only recovery deadline exhausted");
          if (!isSameChatGptConversation(session, page.url())) throw new Error("Recovery conversation identity changed during read");
          const text = readCompletedTurn(data, conversationId, turn, request.allowToolReportedStatus === true);
          debugLog("browser.recovery", { phase: "post-submit", attempt, requestedUrl: session, actualUrl: page.url(), decision: text ? "completed" : "still-running" });
          return text;
        };
        const text = await Promise.race([
          observe(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("Timeout: read-only recovery deadline exhausted")); }, budget); }),
        ]);
        if (text) return text;
      } catch (error) {
        if (!isTransientBrowserFailure(error)) throw error;
        debugLog("browser.recovery", { phase: "post-submit", attempt, decision: "read-transient" });
        await this.close();
      } finally {
        expired = true;
        if (timer) clearTimeout(timer);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - Date.now()))));
    }
    throw new Error("read-only recovery deadline expired; matching turn still-running or inaccessible");
  }

  private assertIdentity(request: WorkerRequest, page: Page, enforceScope: boolean): void {
    if (enforceScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), request.sessionId !== undefined);
    if (request.sessionId && !isSameChatGptConversation(request.sessionId, page.url())) throw new Error("ChatGPT redirected to a different conversation while resuming");
  }

  private async getContext(timeout = 15_000, needsStream = true): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    if (this.ownedProcess) await this.close();
    const launch = this.launchContext(timeout, needsStream);
    this.launching = launch;
    try { return await launch; }
    finally { if (this.launching === launch) this.launching = undefined; }
  }

  private async launchContext(timeout: number, needsStream = true): Promise<BrowserContext> {
    await mkdir(this.config.profileDir, { recursive: true });
    debugLog("browser.context", {
      phase: "launch",
      engine: "camoufox",
      headless: this.config.headless,
      browserMode: this.config.headless ? "headless" : "headed",
    });
    const identity = await chatGptBrowserDeps.loadIdentity(this.config.profileDir);
    const baseline = await profileProcesses(this.config.profileDir).catch(() => undefined);
    const context = await chatGptBrowserDeps.launchPersistentContext(
      this.config.profileDir,
      { timeout, headless: this.config.headless, identity },
    );

    this.context = context;
    const launched = baseline
      ? (await profileProcesses(this.config.profileDir).catch(() => []))
          .filter(candidate => !baseline.some(existing => existing.pid === candidate.pid))
      : [];
    this.ownedProcess = launched.length === 1 ? launched[0] : undefined;
    if (this.ownedProcess && this.onOwnedBrowserProcess) {
      try { await this.onOwnedBrowserProcess(this.ownedProcess); }
      catch (error) {
        await this.close();
        throw error;
      }
    }
    context.on("close", () => {
      if (this.context === context) { this.context = undefined; this.workerPages.clear(); }
    });
    try {
      if (needsStream) await context.addInitScript({ content: CHATGPT_RESPONSE_LOADER_SOURCE });
    } catch (error) {
      await this.close();
      throw error;
    }
    return context;
  }

  private async getWorkerPage(request: WorkerRequest, context: BrowserContext): Promise<Page> {
    const workerId = request.workerId ?? "__default__";
    const existing = this.workerPages.get(workerId);
    if (existing && !existing.isClosed?.()) return existing;
    const known = request.knownBrowserSessions ?? {};
    // Reuse the initial about:blank page rather than spawning an extra window.
    // Additional worker pages must be opened as browser tabs from a live page,
    // not via Playwright context.newPage() (which can create Firefox windows).
    const pickPage = async (): Promise<Page> => {
      const used = new Set(this.workerPages.values());
      const open = context.pages?.().filter(page => !page.isClosed?.()) ?? [];
      const available = open.find(page => !used.has(page) && page.url() === "about:blank");
      if (available) return available;
      if (this.workerPages.size === 0) return open[0] ?? await context.newPage();
      if (!open.length) throw new Error("Shared browser has no live tab to open a sibling tab");
      return await openWorkerTabInSameWindow(context, open.find(page => used.has(page)) ?? open[0]!);
    };

    // First claim ALL currently open pages matching known saved sessions.
    // Otherwise, a missing worker with earlier insertion order could steal a
    // later worker's restored tab before that later worker is matched.
    const sessions = Object.entries(known);
    for (const [id, session] of sessions) {
      if (this.workerPages.has(id) && !this.workerPages.get(id)!.isClosed?.()) continue;
      const matching = context.pages?.().find(page =>
        !page.isClosed?.() && ![...this.workerPages.values()].includes(page) &&
        isSameChatGptConversation(session, page.url()),
      );
      if (matching) this.workerPages.set(id, matching);
    }
    for (const [id, session] of sessions) {
      const knownPage = this.workerPages.get(id);
      if (knownPage && !knownPage.isClosed?.()) continue;
      const candidate = await pickPage();
      this.workerPages.set(id, candidate);
      if (id !== workerId) {
        await candidate.goto(session, { waitUntil: "domcontentloaded", timeout: Math.min(this.timeoutMs, 15_000) });
        if (!isSameChatGptConversation(session, candidate.url()))
          throw new Error("Failed to reconstruct saved browser tab for worker " + id);
      }
    }

    const reconstructed = this.workerPages.get(workerId);
    if (reconstructed && !reconstructed.isClosed?.()) return reconstructed;
    const page = await pickPage();
    this.workerPages.set(workerId, page);
    return page;
  }
}

/** Firefox/Camoufox: request an actual tab from the existing top-level page.
 * Never silently fall back to context.newPage() and open another window. */
export async function openWorkerTabInSameWindow(
  context: BrowserContext, existingPage: Page, timeout = 8_000,
): Promise<Page> {
  await existingPage.bringToFront();
  const pending = context.waitForEvent("page", { timeout });
  const [, page] = await Promise.all([
    existingPage.evaluate(() => window.open("about:blank", "_blank")),
    pending,
  ]);
  if (page.context() !== context) throw new Error("New worker tab escaped its browser context");
  return page;
}


export function isSameChatGptConversation(requestedUrl: string, actualUrl: string): boolean {
  try {
    const requested = validateChatGptUrl(requestedUrl);
    const actual = validateChatGptUrl(actualUrl);
    const route = /^\/(?:g\/([^/]+)\/)?c\/([^/]+)\/?$/;
    const original = route.exec(requested.pathname);
    const opened = route.exec(actual.pathname);
    if (!original || !opened || isProvisionalChatGptConversationId(original[2])) return false;
    const requestedProject = original[1] ? canonicalChatGptProjectId(original[1]) : null;
    const openedProject = opened[1] ? canonicalChatGptProjectId(opened[1]) : null;
    return requested.origin === actual.origin &&
      requestedProject === openedProject && original[2] === opened[2];
  } catch { return false; }
}

async function closeBeforeDeadline(close: () => Promise<void>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Issue cleanup even at exhaustion; do not let browser transport cleanup
    // extend the recovery budget. The owned close request may settle later.
    await Promise.race([
      close().catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PreparedMessage { token: number; useButton: boolean }

async function prepareMessage(
  page: Page, prompt: string, timeoutMs: number, needsStream = true,
): Promise<PreparedMessage> {
  await page.locator(COMPOSER).first().fill(prompt, { timeout: timeoutMs });
  if (!needsStream) return { token: 0, useButton: await page.locator(SEND).first().isVisible() };
  const token = await page.evaluate(() => {
    const arm = (window as unknown as { __DEVOS_ARM_STREAM__?: (prompt: string) => number }).__DEVOS_ARM_STREAM__;
    if (!arm) throw new Error("ChatGPT response loader is not installed");
    return arm(prompt);
  });
  return { token, useButton: await page.locator(SEND).first().isVisible() };
}

export function isTransientBrowserFailure(error: unknown): boolean {
  return classifyBrowserFailure(error).action === "retry";
}

export async function submitOnly(
  page: Page, prompt: string, timeoutMs: number,
  beforeSubmit?: () => void | Promise<void>, prepared?: PreparedMessage,
): Promise<void> {
  const message = prepared ?? await prepareMessage(page, prompt, timeoutMs);
  await beforeSubmit?.();
  if (message.useButton) {
    await page.locator(SEND).first().click({ timeout: Math.min(timeoutMs, 15_000) });
  } else {
    await page.locator(COMPOSER).first().press("Enter", { timeout: Math.min(timeoutMs, 15_000) });
  }
}

export async function sendAndRead(
  page: Page,
  prompt: string,
  timeoutMs: number,
  beforeSubmit?: () => void | Promise<void>,
  prepared?: PreparedMessage,
): Promise<string> {
  const message = prepared ?? await prepareMessage(page, prompt, timeoutMs);
  const request = message.token;
  const composer = page.locator(COMPOSER).first();
  const send = page.locator(SEND).first();
  if (message.useButton) {
    await beforeSubmit?.();
    await send.click({ timeout: Math.min(timeoutMs, 15_000) });
  } else {
    await beforeSubmit?.();
    await composer.press("Enter", { timeout: Math.min(timeoutMs, 15_000) });
  }

  const domAbort = new AbortController();
  const sseRead = (async () => {
  const startedAt = Date.now();
  await page.waitForFunction(
    ({ token, startedAt, idleMs }) => {
      const state = (
        window as unknown as {
          __DEVOS_STREAM_STATE__?: {
            request: number;
            text: string | null;
            failed: boolean;
            lastActivityAt?: number;
          };
        }
      ).__DEVOS_STREAM_STATE__;
      return state?.request === token && (state.text !== null || state.failed || Date.now() - (state.lastActivityAt ?? startedAt) >= idleMs);
    },
    { token: request, startedAt, idleMs: Math.min(timeoutMs, 5 * 60_000) },
    { timeout: timeoutMs, polling: 500 },
  );

  const state = await page.evaluate(() =>
    (
      window as unknown as {
        __DEVOS_STREAM_STATE__: {
          text: string | null;
          failed: boolean;
        };
      }
    ).__DEVOS_STREAM_STATE__,
  );

  if (!state.failed && state.text === null) throw new Error("ChatGPT response idle timeout; read-only recovery required");
  if (state.failed || !state.text?.trim()) {
    throw new Error("ChatGPT response failed or did not complete");
  }

  return state.text;
  })();
  const domRead = readExactDomFinal(page, prompt, timeoutMs, domAbort.signal)
    .then(text => text === null ? new Promise<never>(() => {}) : text);
  try {
    return await Promise.race([sseRead, domRead]);
  } finally {
    domAbort.abort();
    // A rejected/late Playwright read is handled by its awaiting Promise.race
    // handler; no extra DOM submission or network request is ever created.
  }
}

export async function waitForConversationUrl(
  page: Pick<Page, "url">, timeoutMs: number, projectUrl?: string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = validateChatGptUrl(page.url());
    const conversation = /\/c\/([^/?#]+)/.exec(current.pathname)?.[1];
    if (conversation && !isProvisionalChatGptConversationId(conversation)) {
      if (projectUrl) assertChatGptProjectScope(projectUrl, current.href, true);
      return current.href;
    }
    if (projectUrl) {
      // Immediately reject navigation into a different Project/standalone
      // conversation; only the expected Project home and provisional chat
      // states can be polled while awaiting durable identity.
      assertChatGptProjectScope(projectUrl, current.href, false);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("ChatGPT conversation URL did not appear before timeout; prompt not replayed");
}

/** Safe, structural diagnostics; never log POST content, message IDs,
 * bodies, auth headers, user text or conversation identifiers. */
export function conversationRequestShape(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return { format: "unknown" };
  const body = payload as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    format: "object",
    hasMessagesArray: Array.isArray(body.messages),
    messageCount: messages.length,
    authorRoles: messages.slice(0, 10).map(message => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return "unknown";
      const value = (message as { author?: { role?: unknown } }).author?.role;
      return ["user", "assistant", "tool", "system"].includes(String(value)) ? value : "unknown";
    }),
    hasMessageIds: messages.slice(0, 10).map(message =>
      !!message && typeof message === "object" && typeof (message as { id?: unknown }).id === "string"),
    partShapes: messages.slice(0, 10).map(message => {
      const content = message && typeof message === "object"
        ? (message as { content?: { parts?: unknown } }).content : null;
      if (!content || !Array.isArray(content.parts)) return "none";
      return content.parts.map(part => typeof part === "string" ? "text" : part && typeof part === "object" ? "object" : "other").slice(0, 10);
    }),
    hasConversationId: typeof body.conversation_id === "string",
  };
}

/** ChatGPT composer may normalize line endings, NBSP or trailing blank lines.
 * Do not collapse interior whitespace or accept partial/similar prompts. */
export function normalizedSubmittedText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").normalize("NFC").trim();
}

export function extractSubmittedTurn(payload: unknown, prompt: string): SubmittedTurn | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  if (!Array.isArray(body.messages)) return null;
  const nonce = /DevOS browser attempt ID: ([a-f0-9]{64})\b/.exec(prompt)?.[1];
  const candidates = body.messages.filter((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const user = entry as Record<string, any>;
    if (user.author?.role !== "user") return false;
    const parts = user.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) return false;
    const text: string[] = [];
    for (const part of parts) {
      if (typeof part === "string") { text.push(part); continue; }
      // Some ChatGPT request formats encode plain text as typed parts.
      // Reject attachments, images, unsupported parts and mixed content:
      // the outgoing user message must still match our full prompt exactly.
      if (part && typeof part === "object" && !Array.isArray(part) &&
          ["text", "input_text"].includes(part.type ?? part.content_type) &&
          typeof part.text === "string") { text.push(part.text); continue; }
      return false;
    }
    const submitted = text.join("");
    return normalizedSubmittedText(submitted) === normalizedSubmittedText(prompt) ||
      !!(nonce && submitted.includes(nonce));
  });
  if (candidates.length !== 1) return null;
  const user = candidates[0] as Record<string, any>;
  if (typeof user.id !== "string" || !user.id || user.id.length > 200) return null;
  const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
  return {
    messageId: user.id,
    ...(identifier(body.conversation_id) ? { conversationId: identifier(body.conversation_id)! } : {}),
    ...(identifier(body.request_id ?? user.metadata?.request_id) ? { requestId: identifier(body.request_id ?? user.metadata?.request_id)! } : {}),
    ...(identifier(body.turn_exchange_id ?? user.metadata?.turn_exchange_id) ? { turnExchangeId: identifier(body.turn_exchange_id ?? user.metadata?.turn_exchange_id)! } : {}),
  };
}
