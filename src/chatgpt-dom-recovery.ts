import type { Page } from "playwright-core";
import { parseDevosResult } from "./result.js";

/** Conservative, read-only fallback when a live ChatGPT SSE stream cannot be
 * identified. Never send a prompt or infer success from UI spinners/recency.
 * Only one exact matching user message and one stable terminal answer qualify. */
export async function readExactDomFinal(
  page: Pick<Page, "evaluate">, prompt: string, timeoutMs = 3_000,
  signal?: AbortSignal,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let prior: string | null = null;
  do {
    if (signal?.aborted) return null;
    const candidate = await page.evaluate((exactPrompt: string) => {
      const visible = (node: Element) => (node as HTMLElement).getClientRects().length > 0;
      const turns = Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]'))
        .filter(visible);
      const users = turns.filter(node => node.getAttribute("data-message-author-role") === "user" &&
        (node as HTMLElement).innerText.trim() === exactPrompt.trim());
      // Two identical prompts in one conversation are ambiguous.
      if (users.length !== 1) return null;
      const user = users[0]!;
      const index = turns.indexOf(user);
      if (turns.slice(index + 1).some(node => node.getAttribute("data-message-author-role") === "user"))
        return null;
      const assistant = turns.slice(index + 1)
        .filter(node => node.getAttribute("data-message-author-role") === "assistant");
      if (assistant.length !== 1) return null;
      const generating = Array.from(document.querySelectorAll(
        '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]',
      )).some(visible);
      if (generating) return null;
      const content = assistant[0]!.querySelector(".markdown") ?? assistant[0]!;
      return (content as HTMLElement).innerText.trim();
    }, prompt).catch(() => null);
    if (typeof candidate === "string" && candidate.trim()) {
      try {
        parseDevosResult(candidate);
        if (prior === candidate) return candidate;
        prior = candidate;
      } catch {
        prior = null;
      }
    } else {
      prior = null;
    }
    const wait = Math.min(300, deadline - Date.now());
    if (wait > 0) await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
      timer = setTimeout(finish, wait);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  } while (Date.now() < deadline);
  return null;
}
