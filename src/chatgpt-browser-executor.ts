import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { Executor, WorkerRequest } from "./executor.js";
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
      validateChatGptUrl(url);
      if (projectScope && request.sessionId) {
        assertChatGptProjectScope(this.config.projectUrl, request.sessionId, true);
      }

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
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

      const response = sendAndRead(page, request.prompt, this.timeoutMs).then(
        text => ({ text } as const),
        error => ({ error } as const),
      );
      const sessionId = await waitForConversationUrl(page, this.timeoutMs);
      if (projectScope) {
        assertChatGptProjectScope(this.config.projectUrl, sessionId, true);
      }
      await request.onSession?.(sessionId);

      const outcome = await response;
      if ("error" in outcome) throw outcome.error;
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

export async function sendAndRead(
  page: Page,
  prompt: string,
  timeoutMs: number,
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
    await send.click({ timeout: timeoutMs });
  } else {
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
