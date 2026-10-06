import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ChatGptBrowserConfig {
  projectUrl: string;
  browserChannel: string;
  profileDir: string;
  headless: boolean;
}

export function loadChatGptBrowserConfig(
  env: Record<string, string | undefined> = process.env,
  projectUrlOverride?: string,
): ChatGptBrowserConfig {
  const projectUrl =
    projectUrlOverride?.trim() ||
    env.DEVOS_CHATGPT_PROJECT_URL?.trim() ||
    "https://chatgpt.com/";
  validateChatGptUrl(projectUrl);

  const headless = env.DEVOS_BROWSER_HEADLESS?.trim() || "0";
  if (headless !== "0" && headless !== "1") {
    throw new Error("DEVOS_BROWSER_HEADLESS must be 0 or 1");
  }

  return {
    projectUrl,
    browserChannel: env.DEVOS_BROWSER_CHANNEL?.trim() || "chrome",
    profileDir: resolve(
      env.DEVOS_BROWSER_PROFILE_DIR?.trim() ||
        join(homedir(), ".devos", "browser-profile"),
    ),
    headless: headless === "1",
  };
}

export function validateChatGptUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid ChatGPT URL");
  }

  if (
    url.protocol !== "https:" ||
    !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname)
  ) {
    throw new Error("Invalid ChatGPT URL");
  }

  return url;
}


export interface ChatGptProjectScope {
  origin: string;
  projectId: string;
}

export function getChatGptProjectScope(value: string): ChatGptProjectScope | null {
  const url = validateChatGptUrl(value);
  if (url.pathname === "/") return null;

  const match = /^\/g\/([^/]+)(?:\/c)?\/?$/.exec(url.pathname);
  if (!match?.[1]) {
    throw new Error(
      "Invalid configured ChatGPT Project URL; expected /g/<project-id>/ or /g/<project-id>/c/",
    );
  }
  return { origin: url.origin, projectId: match[1] };
}

export function assertChatGptProjectScope(
  projectUrl: string,
  candidateUrl: string,
  requireConversation = false,
): URL {
  const candidate = validateChatGptUrl(candidateUrl);
  const scope = getChatGptProjectScope(projectUrl);
  if (!scope) return candidate;

  const match = /^\/g\/([^/]+)(?:\/c(?:\/([^/]+))?)?\/?$/.exec(
    candidate.pathname,
  );
  const projectId = match?.[1];
  const conversationId = match?.[2];

  if (candidate.origin !== scope.origin || projectId !== scope.projectId) {
    throw new Error("ChatGPT browser escaped the configured Project");
  }
  if (requireConversation && !conversationId) {
    throw new Error("ChatGPT Project conversation URL did not appear");
  }

  return candidate;
}
