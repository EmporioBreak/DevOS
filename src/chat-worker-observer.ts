import type { Page } from "playwright-core";
import type { TaskRef } from "./workflow.js";
import { exactWorkerHistoryProof } from "./chat-worker-history-proof.js";
import { localWorkerAuthorization } from "./chat-worker-grants.js";
import { debugLog } from "./debug-log.js";

const MAX_WINDOW_MS = 2 * 60_000;
const HISTORY_INTERVAL_MS = 7_000;
const MAX_HISTORY_CHECKS = 12;

/** A path alone is not provider provenance: unrelated origins can emit the
 * same URL path. Only a successful HTTPS response from the saved ChatGPT
 * conversation's exact origin can feed the privileged worker verifier. */
export function isExactWorkerHistoryEndpoint(
  responseUrl: string, exactChatUrl: string,
): boolean {
  try {
    const expected = new URL(exactChatUrl);
    const candidate = new URL(responseUrl);
    const id = /\/c\/([^/?#]+)$/.exec(expected.pathname)?.[1];
    return expected.protocol === "https:" && !!id &&
      candidate.origin === expected.origin &&
      candidate.pathname === "/backend-api/conversations/" + id;
  } catch { return false; }
}
export function isExactWorkerHistoryResponse(
  responseUrl: string, status: number, exactChatUrl: string,
): boolean {
  return status === 200 && isExactWorkerHistoryEndpoint(responseUrl, exactChatUrl);
}

/** Read the provider's structured response for ONE exact saved worker chat.
 * A separate temporary page avoids reloading/resubmitting the worker turn.
 * Never search arbitrary chats, the sidebar, assistant text, or tool arguments. */
async function readExactHistory(
  workerPage: Page,
  url: string,
  userMessageId: string | undefined,
  exactPrompt: string,
  resourceUri: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (signal.aborted || workerPage.url() !== url) return null;
  let verifier: Page | undefined;
  try {
    verifier = await workerPage.context().newPage();
    await workerPage.bringToFront().catch(() => {});
    // Accept even an explicit denial from the exact provider endpoint so
    // diagnostics can distinguish HTTP 401/404 from an absent response.
    // Neither denial nor a different-origin response can grant access.
    const responseWait = verifier.waitForResponse(response =>
      isExactWorkerHistoryEndpoint(response.url(), url),
      { timeout: 14_000 });
    void responseWait.catch(() => {});
    await verifier.goto(url, { waitUntil: "domcontentloaded", timeout: 14_000 });
    if (signal.aborted || verifier.url() !== url || workerPage.url() !== url) return null;
    const response = await responseWait;
    if (signal.aborted || verifier.url() !== url || workerPage.url() !== url) return null;
    if (response.status() !== 200) {
      debugLog("browser.worker-access", { phase: "provider-history", decision: "http-unavailable", httpStatus: response.status() });
      return null;
    }
    const history: unknown = await response.json();
    return exactWorkerHistoryProof(history, url, userMessageId, resourceUri, exactPrompt);
  } catch { return null; }
  finally { await verifier?.close().catch(() => {}); }
}

/** Fail-closed, bounded read-only browser observation. Authorization occurs
 * only after the local task state AND exact provider tool result match.
 * This observer is used exclusively for DevOS-created browser workers. */
export async function observeWorkerAuthorization(input: {
  page: Page;
  root: string;
  task: TaskRef;
  workerId: string;
  turn: number;
  expectedConversation: () => string | undefined;
  expectedUserMessageId?: () => string | undefined;
  exactSubmittedPrompt: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const local = localWorkerAuthorization(input.root);
  if (!local) return false;
  const deadline = Date.now() + MAX_WINDOW_MS;
  let checks = 0;
  while (!input.signal.aborted && Date.now() < deadline && checks < MAX_HISTORY_CHECKS) {
    const expected = input.expectedConversation();
    if (expected && input.page.url() === expected) {
      checks++;
      const nonce = await readExactHistory(
        input.page, expected, input.expectedUserMessageId?.(),
        input.exactSubmittedPrompt, local.resourceUri, input.signal,
      );
      if (nonce && !input.signal.aborted && input.page.url() === expected &&
          input.expectedConversation() === expected) {
        const granted = local.registry.bindVerified(
          nonce, input.task, input.workerId, input.turn, expected,
        );
        debugLog("browser.worker-access", {
          phase: "exact-provider-history", workerId: input.workerId,
          turn: input.turn, granted,
        });
        if (granted) return true;
      }
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, HISTORY_INTERVAL_MS);
      function done() {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", done);
        resolve();
      }
      input.signal.addEventListener("abort", done, { once: true });
      if (input.signal.aborted) done();
    });
  }
  return false;
}
