import { profileProcesses, terminateOwnedBrowser, type OwnedBrowserProcess } from "./owned-browser-process.js";
import { readCompletedTurn, type SubmittedTurn } from "./chatgpt-turn-recovery.js";
import { mkdir } from "node:fs/promises";
import { Camoufox } from "@camoufox/camoufox";
import type { BrowserContext, Page } from "playwright-core";
import type { Executor, WorkerRequest } from "./executor.js";
import { debugLog } from "./debug-log.js";
import type { WorkerOutput } from "./workflow.js";
import {
  assertChatGptProjectScope,
  getChatGptProjectScope,
  isProvisionalChatGptConversationId,
  loadChatGptBrowserConfig,
  validateChatGptUrl,
  type ChatGptBrowserConfig,
} from "./browser-config.js";
import { CHATGPT_RESPONSE_LOADER_SOURCE } from "./chatgpt-response-loader.js";

export class BrowserResumeUnavailableError extends Error {
  constructor(readonly sessionId: string, message: string) {
    super(message);
    this.name = "BrowserResumeUnavailableError";
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
  launchPersistentContext: (
    profileDir: string,
    options: { headless: boolean; timeout: number },
  ): Promise<BrowserContext> =>
    Camoufox({
      user_data_dir: profileDir,
      persistent_context: true,
      headless: options.headless,
      timeout: options.timeout,
    }),
};

export class ChatGptBrowserExecutor implements Executor {
  readonly kind = "chatgpt_browser" as const;
  private context: BrowserContext | undefined;
  private ownedProcess: OwnedBrowserProcess | undefined;
  private launching: Promise<BrowserContext> | undefined;

  constructor(
    private readonly config: ChatGptBrowserConfig = loadChatGptBrowserConfig(),
    private readonly timeoutMs = 60 * 60_000,
  ) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    try { return await this.runTurn(request); }
    finally {
      // A launch that raced the preparation deadline still belongs to this turn.
      const launching = this.launching;
      if (launching) {
        let settled = false;
        await closeBeforeDeadline(async () => { await launching; settled = true; }, Date.now() + Math.min(this.timeoutMs, 5_000));
        if (!settled && this.launching === launching) {
          void launching.then(() => this.close()).catch(() => debugLog("browser.cleanup", { decision: "late-launch-cleanup-unconfirmed" }));
          throw new Error("Browser cleanup unconfirmed: browser launch still pending after cleanup deadline");
        }
      }
      await this.close();
    }
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
    } = await this.prepare(request, !!projectScope);
    let mayHaveSubmitted = false;
    let submitted: SubmittedTurn | undefined;
    let submissionAmbiguous = false;
    let durableSession = request.sessionId;
    const rememberSession = async (session: string) => {
      if (durableSession && !isSameChatGptConversation(durableSession, session)) throw new Error("ChatGPT changed conversation identity");
      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, session, true);
      durableSession = session;
      await request.onSession?.(session);
    };
    page.on("request", outgoing => {
      if (!mayHaveSubmitted) return;
      try {
        const target = new URL(outgoing.url());
        if (target.origin !== new URL(url).origin || !/^\/backend-api\/(?:f\/)?conversation\/?$/.test(target.pathname) || outgoing.method() !== "POST") return;
        const payload = outgoing.postDataJSON();
        const user = payload?.messages?.length === 1 ? payload.messages[0] : undefined;
        if (submitted || !user || user.author?.role !== "user" || typeof user.id !== "string" || !user.id || user.id.length > 200 || user.content?.parts?.join("") !== request.prompt) {
          submissionAmbiguous = true; return;
        }
        submitted = {
          messageId: user.id,
          ...(typeof payload.conversation_id === "string" ? { conversationId: payload.conversation_id } : {}),
          ...(typeof (payload.request_id ?? user.metadata?.request_id) === "string" ? { requestId: payload.request_id ?? user.metadata.request_id } : {}),
          ...(typeof (payload.turn_exchange_id ?? user.metadata?.turn_exchange_id) === "string" ? { turnExchangeId: payload.turn_exchange_id ?? user.metadata.turn_exchange_id } : {}),
        };
        debugLog("browser.submission", { phase: "post-submit", captured: true, submittedMessageId: submitted.messageId, conversationId: submitted.conversationId });
      } catch { submissionAmbiguous = true; }
    });
    try {
      let submissionStarted!: () => void;
      const submission = new Promise<void>(resolve => { submissionStarted = resolve; });
      const assertSubmissionScope = () => {
        try {
          const backendFailure = getBackendFailure();
          if (backendFailure) throw backendFailure;
          if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), request.sessionId !== undefined);
          if (request.sessionId && !isSameChatGptConversation(request.sessionId, page.url())) throw new Error("ChatGPT changed saved conversation before submission");
          mayHaveSubmitted = true;
          submissionStarted();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (request.sessionId) throw new BrowserResumeUnavailableError(request.sessionId, message);
          throw new BrowserPreSubmitFailureError(message);
        }
      };
      const response = sendAndRead(page, request.prompt, this.timeoutMs, assertSubmissionScope, preparedMessage).then(
        text => ({ text } as const),
        error => ({ error } as const),
      );

      if (request.sessionId) {
        const outcome = await response;
        if ("error" in outcome) throw outcome.error;
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
      const sessionId = await waitForConversationUrl(page, Math.min(this.timeoutMs, 45_000));

      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, sessionId, true);
      debugLog("browser.session.ready", { sessionId, actualUrl: page.url() });
      await rememberSession(sessionId);

      const outcome = await response;
      if ("error" in outcome) throw outcome.error;
      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), true);
      if (!isSameChatGptConversation(sessionId, page.url())) throw new Error("ChatGPT changed fresh conversation after submission");
      debugLog("browser.response", { sessionId, textLength: outcome.text.length });
      return { text: outcome.text, sessionId };
    } catch (error) {
      const cause = error instanceof Error ? error.message.split("\n")[0]! : "Browser operation failed";
      if (mayHaveSubmitted) {
        debugLog("browser.recovery", { attempt: 1, phase: "post-submit", sessionId: durableSession, captured: !!submitted && !submissionAmbiguous, decision: "reload/read-only" });
        try {
          if (!submitted || submissionAmbiguous || !durableSession) throw new Error("submitted user/conversation identity absent or ambiguous");
          const conversationId = /\/c\/([^/?#]+)/.exec(new URL(durableSession).pathname)?.[1];
          if (!conversationId || (submitted.conversationId && submitted.conversationId !== conversationId)) throw new Error("submitted conversation identity changed");
          // An observed identity change is definitive; never follow it or mask it.
          if (!isSameChatGptConversation(durableSession, page.url())) throw new Error("actual conversation identity changed");
          await rememberSession(durableSession);
          const text = await this.recoverTurn(durableSession, conversationId, submitted);
          return { text, sessionId: durableSession };
        } catch (recoveryError) {
          const reason = recoveryError instanceof Error ? recoveryError.message.split("\n")[0]! : "read unavailable";
          debugLog("browser.recovery", { attempt: 1, phase: "post-submit", sessionId: durableSession, decision: "stopped-ambiguous", submittedMessageId: submitted?.messageId, reason });
          throw new Error(`Browser recovery attempt=1 phase=post-submit: prompt not replayed; saved identity preserved (conversation=${durableSession ?? "unknown"}, user-message=${submitted?.messageId ?? "unknown"}); ${cause}; read-only recovery: ${reason}`);
        }
      }
      throw error;
    } finally {
      await closeBeforeDeadline(() => page.close(), Date.now() + Math.min(this.timeoutMs, 5_000));
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    const owned = this.ownedProcess;
    if (!context && !owned) return;
    debugLog("browser.cleanup", { phase: "context", decision: "closing" });
    let confirmed = false;
    if (context) await closeBeforeDeadline(async () => { await context.close(); confirmed = true; }, Date.now() + Math.min(this.timeoutMs, 5_000));
    if (!confirmed && owned) {
      debugLog("browser.cleanup", { phase: "context", decision: "terminate-owned-process" });
      confirmed = await terminateOwnedBrowser(owned, this.config.profileDir);
    }
    if (!confirmed) {
      debugLog("browser.cleanup", { phase: "context", decision: "unconfirmed" });
      throw new Error("Browser cleanup unconfirmed: bounded close failed; no unproven/user browser process was killed");
    }
    if (this.context === context) this.context = undefined;
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
  }> {
    const url = request.sessionId ?? this.config.projectUrl;
    const deadline = Date.now() + Math.min(this.timeoutMs, 45_000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let page: Page | undefined;
      let phase = "context";
      let expired = false;
      let backendFailure: Error | undefined;
      const budget = Math.min(15_000, deadline - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (budget <= 0) throw new Error("Timeout: preparation deadline exhausted");
        const preparation = async () => {
          const context = await this.getContext(budget);
          if (expired) { await this.close(); throw new Error("Timeout: preparation deadline exhausted"); }
          phase = "new-page";
          page = context.pages?.().find(candidate => !candidate.isClosed?.()) ?? await context.newPage();
          if (expired) { await page.close(); throw new Error("Timeout: preparation deadline exhausted"); }
          const currentPage = page;
          currentPage.on("response", response => {
            const target = new URL(response.url());
            const status = response.status();
            if (target.origin === new URL(url).origin && target.pathname.startsWith("/backend-api/") && status >= 500) backendFailure = new Error(`Transient backend HTTP ${status}`);
            if (target.origin === new URL(url).origin && target.pathname.startsWith("/backend-api/") && (status === 401 || status === 403)) {
              const challenge = (response.headers()["content-type"] ?? "").includes("text/html");
              backendFailure = new Error(`ChatGPT ${challenge ? "authentication/challenge" : "authentication/access"} blocked backend (HTTP ${status})${status === 401 ? "; visible login/debug run needed (DEVOS_BROWSER_HEADLESS=0)" : ""}`);
            }
          });
          phase = "navigation";
          const response = await currentPage.goto(url, { waitUntil: "domcontentloaded", timeout: budget });
          if (expired) throw new Error("Timeout: preparation deadline exhausted");
          debugLog("browser.navigation", { requestedUrl: url, actualUrl: currentPage.url(), attempt });
          const status = response?.status();
          if (status === 401 || status === 403) throw new Error(`ChatGPT authentication/challenge blocked navigation (HTTP ${status})${status === 401 ? "; visible login/debug run needed (DEVOS_BROWSER_HEADLESS=0)" : ""}`);
          if (status === 404 || status === 410) throw new Error(`ChatGPT conversation unavailable (HTTP ${status})`);
          if (status && status >= 500) throw new Error(`Transient navigation HTTP ${status}`);
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
            if (/cloudflare|verify you are human|just a moment|checking your browser|провер.*человек/i.test(body)) throw new Error("ChatGPT authentication/challenge required");
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
          const prepared = await prepareMessage(currentPage, request.prompt, budget);
          if (backendFailure) throw backendFailure;
          this.assertIdentity(request, currentPage, enforceScope);
          return {
            page: currentPage,
            prepared,
            getBackendFailure: () => backendFailure,
          };
        };
        const outcome = await Promise.race([
          preparation(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("Timeout: preparation deadline exhausted")); }, budget); }),
        ]);
        debugLog("browser.recovery", { attempt, phase, decision: "ready", requestedUrl: url });
        return outcome;
      } catch (error) {
        expired = true;
        const effectiveError = backendFailure ?? error;
        const cause = effectiveError instanceof Error ? effectiveError.message.split("\n")[0]! : "Browser operation failed";
        const transient = isTransientBrowserFailure(effectiveError);
        await closeBeforeDeadline(() => page?.close() ?? Promise.resolve(), deadline);
        if (/closed|crashed|disconnected/i.test(cause)) {
          await closeBeforeDeadline(() => this.close(), deadline);
        }
        const retry = transient && attempt < 3 && Date.now() < deadline;
        debugLog("browser.recovery", { attempt, phase, cause, requestedUrl: url, actualUrl: page?.url(), decision: retry ? "retry-same-session" : "stop" });
        if (!retry) {
          const message = `Browser recovery attempt=${attempt} phase=${phase} ${transient ? "transient" : "definitive"}: ${cause}; saved identity preserved`;
          if (request.sessionId) throw new BrowserResumeUnavailableError(request.sessionId, message);
          throw new BrowserPreSubmitFailureError(message);
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error("Browser preparation exhausted");
  }

  private async recoverTurn(session: string, conversationId: string, turn: SubmittedTurn): Promise<string> {
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
          const context = await this.getContext(budget);
          if (expired) throw new Error("Timeout: read-only recovery deadline exhausted");
          const page = context.pages?.().find(candidate => !candidate.isClosed?.()) ?? await context.newPage();
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
          const text = readCompletedTurn(data, conversationId, turn);
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

  private async getContext(timeout = 15_000): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    if (this.ownedProcess) await this.close();
    const launch = this.launchContext(timeout);
    this.launching = launch;
    try { return await launch; }
    finally { if (this.launching === launch) this.launching = undefined; }
  }

  private async launchContext(timeout: number): Promise<BrowserContext> {
    await mkdir(this.config.profileDir, { recursive: true });
    debugLog("browser.context", {
      phase: "launch",
      engine: "camoufox",
      headless: this.config.headless,
      browserMode: this.config.headless ? "headless" : "headed",
    });
    const baseline = await profileProcesses(this.config.profileDir).catch(() => undefined);
    const context = await chatGptBrowserDeps.launchPersistentContext(
      this.config.profileDir,
      { timeout, headless: this.config.headless },
    );

    this.context = context;
    const launched = baseline
      ? (await profileProcesses(this.config.profileDir).catch(() => []))
          .filter(candidate => !baseline.some(existing => existing.pid === candidate.pid))
      : [];
    this.ownedProcess = launched.length === 1 ? launched[0] : undefined;
    context.on("close", () => {
      if (this.context === context) this.context = undefined;
    });
    try {
      await context.addInitScript({ content: CHATGPT_RESPONSE_LOADER_SOURCE });
    } catch (error) {
      await this.close();
      throw error;
    }
    return context;
  }

}

export function isSameChatGptConversation(requestedUrl: string, actualUrl: string): boolean {
  try {
    const requested = validateChatGptUrl(requestedUrl);
    const actual = validateChatGptUrl(actualUrl);
    const route = /^\/(?:g\/[^/]+\/)?c\/([^/]+)\/?$/;
    const id = route.exec(requested.pathname)?.[1];
    return !!id && !isProvisionalChatGptConversationId(id) && requested.origin === actual.origin && requested.pathname.replace(/\/$/, "") === actual.pathname.replace(/\/$/, "");
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

async function prepareMessage(page: Page, prompt: string, timeoutMs: number): Promise<PreparedMessage> {
  await page.locator(COMPOSER).first().fill(prompt, { timeout: timeoutMs });
  const token = await page.evaluate(() => {
    const arm = (window as unknown as { __DEVOS_ARM_STREAM__?: () => number }).__DEVOS_ARM_STREAM__;
    if (!arm) throw new Error("ChatGPT response loader is not installed");
    return arm();
  });
  return { token, useButton: await page.locator(SEND).first().isVisible() };
}

export function isTransientBrowserFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Timeout|net::ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED)|Execution context was destroyed|Cannot find context with specified id|Target (?:page|browser|context).*closed|(?:page|browser).*crashed|browser.*disconnected|Transient (?:navigation|backend) HTTP 5\d\d/i.test(message);
}

export async function sendAndRead(
  page: Page,
  prompt: string,
  timeoutMs: number,
  beforeSubmit?: () => void,
  prepared?: PreparedMessage,
): Promise<string> {
  const message = prepared ?? await prepareMessage(page, prompt, timeoutMs);
  const request = message.token;
  const composer = page.locator(COMPOSER).first();
  const send = page.locator(SEND).first();
  if (message.useButton) {
    beforeSubmit?.();
    await send.click({ timeout: Math.min(timeoutMs, 15_000) });
  } else {
    beforeSubmit?.();
    await composer.press("Enter", { timeout: Math.min(timeoutMs, 15_000) });
  }

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
}

export async function waitForConversationUrl(
  page: Page,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = validateChatGptUrl(page.url());
    const conversation = /\/c\/([^/?#]+)/.exec(current.pathname)?.[1];
    if (conversation && !isProvisionalChatGptConversationId(conversation)) {
      return current.href;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error("ChatGPT conversation URL did not appear before timeout");
}
