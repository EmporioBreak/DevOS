import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
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

export class ChatGptBrowserExecutor implements Executor {
  readonly kind = "chatgpt_browser" as const;
  private context: BrowserContext | undefined;

  constructor(
    private readonly config: ChatGptBrowserConfig = loadChatGptBrowserConfig(),
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  async run(request: WorkerRequest): Promise<WorkerOutput> {
    const context = await this.getContext();
    const page = await context.newPage();

    try {
      const projectScope = request.enforceProjectScope
        ? getChatGptProjectScope(this.config.projectUrl)
        : null;
      const url = request.sessionId ?? this.config.projectUrl;
      debugLog("browser.session", { decision: request.sessionId ? "resume" : "fresh", requestedUrl: url, projectRoot: request.projectRoot });
      try {
        validateChatGptUrl(url);
        if (projectScope && request.sessionId) {
          assertChatGptProjectScope(this.config.projectUrl, request.sessionId, true);
        }

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
        debugLog("browser.navigation", { requestedUrl: url, actualUrl: page.url() });
        await page.locator(COMPOSER).first().waitFor({
          state: "visible",
          timeout: this.timeoutMs,
        });
        if (projectScope) {
          assertChatGptProjectScope(
            this.config.projectUrl,
            page.url(),
            request.sessionId !== undefined,
          );
        }
        if (request.sessionId && !isSameChatGptConversation(request.sessionId, page.url())) {
          throw new Error("ChatGPT redirected to a different conversation while resuming");
        }
      } catch (error) {
        if (request.sessionId) {
          const message = error instanceof Error ? error.message : String(error);
          debugLog("browser.resume.unavailable", { requestedUrl: request.sessionId, actualUrl: page.url(), reason: message });
          throw new BrowserResumeUnavailableError(request.sessionId, message);
        }
        throw error;
      }

      const assertSubmissionScope = () => {
        try {
          if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), request.sessionId !== undefined);
          if (request.sessionId && !isSameChatGptConversation(request.sessionId, page.url())) throw new Error("ChatGPT changed saved conversation before submission");
        } catch (error) {
          if (request.sessionId) throw new BrowserResumeUnavailableError(request.sessionId, error instanceof Error ? error.message : String(error));
          throw error;
        }
      };
      const response = sendAndRead(page, request.prompt, this.timeoutMs, assertSubmissionScope).then(
        text => ({ kind: "response" as const, text }),
        error => ({ kind: "response" as const, error }),
      );
      const session = waitForConversationUrl(page, this.timeoutMs).then(
        sessionId => ({ kind: "session" as const, sessionId }),
        error => ({ kind: "session" as const, error }),
      );
      const first = await Promise.race([response, session]);
      if ("error" in first) throw first.error;
      let sessionId: string;
      if (first.kind === "session") {
        sessionId = first.sessionId;
      } else {
        const sessionOutcome = await session;
        if ("error" in sessionOutcome) throw sessionOutcome.error;
        sessionId = sessionOutcome.sessionId;
      }
      if (projectScope) {
        assertChatGptProjectScope(this.config.projectUrl, sessionId, true);
      }
      if (request.sessionId && !isSameChatGptConversation(request.sessionId, sessionId)) throw new Error("ChatGPT changed saved conversation after submission");
      debugLog("browser.session.ready", { sessionId, actualUrl: page.url() });
      await request.onSession?.(sessionId);

      const outcome = await response;
      if ("error" in outcome) throw outcome.error;
      if (projectScope) assertChatGptProjectScope(this.config.projectUrl, page.url(), true);
      if (request.sessionId && !isSameChatGptConversation(request.sessionId, page.url())) throw new Error("ChatGPT changed saved conversation after submission");
      debugLog("browser.response", { sessionId, text: outcome.text });
      return { text: outcome.text, sessionId };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    if (context) await context.close();
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    await mkdir(this.config.profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(this.config.profileDir, {
      channel: this.config.browserChannel,
      headless: this.config.headless,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    await context.addInitScript({
      content:
        "Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });",
    });
    await context.addInitScript({ content: CHATGPT_RESPONSE_LOADER_SOURCE });
    this.context = context;
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

export async function sendAndRead(
  page: Page,
  prompt: string,
  timeoutMs: number,
  beforeSubmit?: () => void,
): Promise<string> {
  const composer = page.locator(COMPOSER).first();
  await composer.fill(prompt, { timeout: timeoutMs });

  const request = await page.evaluate(() => {
    const arm = (
      window as unknown as { __DEVOS_ARM_STREAM__?: () => number }
    ).__DEVOS_ARM_STREAM__;
    if (!arm) throw new Error("ChatGPT response loader is not installed");
    return arm();
  });

  const send = page.locator(SEND).first();
  if (await send.isVisible()) {
    beforeSubmit?.();
    await send.click({ timeout: timeoutMs });
  } else {
    beforeSubmit?.();
    await composer.press("Enter", { timeout: timeoutMs });
  }

  await page.waitForFunction(
    token => {
      const state = (
        window as unknown as {
          __DEVOS_STREAM_STATE__?: {
            request: number;
            text: string | null;
            failed: boolean;
          };
        }
      ).__DEVOS_STREAM_STATE__;
      return state?.request === token && (state.text !== null || state.failed);
    },
    request,
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
