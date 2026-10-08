import type { Page } from "playwright-core";
import { getChatGptProjectScope } from "./browser-config.js";
import {
  CHAT_BINDING_ARGUMENT,
  CHAT_BINDING_TOKEN,
} from "./chat-binding-protocol.js";

export const API_BIND_LIMIT = 30;
export const API_BIND_PASSES = 3;
export const API_BIND_CANDIDATE_DELAY_MS = 500;
export const API_BIND_PASS_DELAY_MS = 2000;
export const API_BIND_NAVIGATION_TIMEOUT_MS = 15_000;
export const API_BIND_RESPONSE_TIMEOUT_MS = 15_000;

export interface CanonicalConversationSummary {
  id: string;
  updateTime?: number;
}

export interface CanonicalBindingClient {
  listConversations(): Promise<unknown>;
  hasBindingToken(id: string, token: string): Promise<boolean>;
}

function candidateRows(value: unknown): CanonicalConversationSummary[] {
  const rows =
    value && typeof value === "object" && !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : Array.isArray(value)
        ? value
        : null;
  if (!rows) throw new Error("bind_api_list_shape_unsupported");

  const out: CanonicalConversationSummary[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as {
      id?: unknown;
      conversation_id?: unknown;
      update_time?: unknown;
    };
    const id =
      typeof row.id === "string"
        ? row.id
        : typeof row.conversation_id === "string"
          ? row.conversation_id
          : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const updateTime =
      typeof row.update_time === "number" && Number.isFinite(row.update_time)
        ? row.update_time
        : undefined;
    out.push({ id, ...(updateTime !== undefined ? { updateTime } : {}) });
  }

  if (out.length > 1 && out.every(row => row.updateTime !== undefined)) {
    out.sort((a, b) => b.updateTime! - a.updateTime!);
  }
  return out.slice(0, API_BIND_LIMIT);
}

export async function resolveCanonicalBinding(
  client: CanonicalBindingClient,
  projectUrl: string,
  token: string,
  wait: (ms: number) => Promise<void> = ms =>
    new Promise(resolve => setTimeout(resolve, ms)),
): Promise<string> {
  const scope = getChatGptProjectScope(projectUrl);
  if (!scope) throw new Error("bind_requires_project");
  if (!CHAT_BINDING_TOKEN.test(token)) throw new Error("bind_invalid_token");

  for (let pass = 0; pass < API_BIND_PASSES; pass++) {
    const candidates = candidateRows(await client.listConversations());
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      if (await client.hasBindingToken(candidate.id, token)) {
        return new URL(
          `/g/${scope.projectId}/c/${encodeURIComponent(candidate.id)}`,
          scope.origin,
        ).href;
      }
      if (index + 1 < candidates.length) {
        await wait(API_BIND_CANDIDATE_DELAY_MS);
      }
    }
    if (pass + 1 < API_BIND_PASSES) {
      await wait(API_BIND_PASS_DELAY_MS);
    }
  }
  throw new Error("bind_not_found");
}

const FORWARDED_AUTH_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "oai-did",
  "oai-language",
  "originator",
  "x-oai-mcp-form-version",
  "x-openai-codex-window-type",
  "x-openai-web-frontend",
]);

type BrowserFetchResult = {
  status: number;
  ok: boolean;
  data?: unknown;
};

async function browserJsonFetch(
  page: Page,
  path: string,
  headers: Record<string, string>,
): Promise<BrowserFetchResult> {
  return await page.evaluate(
    async ({ path, headers }) => {
      const response = await fetch(path, {
        credentials: "include",
        headers,
      });
      let data: unknown;
      if (response.ok) {
        try {
          data = await response.json();
        } catch {
          return { status: response.status, ok: false };
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        ...(response.ok ? { data } : {}),
      };
    },
    { path, headers },
  );
}

export async function createCanonicalBindingClient(
  page: Page,
  projectUrl: string,
): Promise<CanonicalBindingClient> {
  const scope = getChatGptProjectScope(projectUrl);
  if (!scope) throw new Error("bind_requires_project");

  const listPath =
    `/backend-api/gizmos/${encodeURIComponent(scope.projectId)}/conversations`;
  const firstListResponse = page.waitForResponse(
    response => {
      try {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.origin === scope.origin &&
          url.pathname === listPath &&
          response.status() === 200
        );
      } catch {
        return false;
      }
    },
    { timeout: API_BIND_RESPONSE_TIMEOUT_MS },
  );

  await page.goto(projectUrl, {
    waitUntil: "domcontentloaded",
    timeout: API_BIND_NAVIGATION_TIMEOUT_MS,
  });

  let response;
  try {
    response = await firstListResponse;
  } catch {
    throw new Error("bind_api_list_unavailable");
  }

  // Reuse only the auth envelope of a request the ChatGPT page itself made.
  // Header values remain in-memory and are never persisted or logged.
  const requestHeaders = await response.request().allHeaders();
  const headers = Object.fromEntries(
    Object.entries(requestHeaders).filter(([name]) =>
      FORWARDED_AUTH_HEADERS.has(name.toLowerCase()),
    ),
  );

  return {
    async listConversations() {
      const query =
        `${listPath}?limit=${API_BIND_LIMIT}&owned_only=true`;
      const result = await browserJsonFetch(page, query, headers);
      if (result.status === 401 || result.status === 403) {
        throw new Error("bind_api_auth_unavailable");
      }
      if (!result.ok) throw new Error("bind_api_list_unavailable");
      return result.data;
    },

    async hasBindingToken(id: string, token: string) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        throw new Error("bind_api_conversation_id_invalid");
      }
      if (!CHAT_BINDING_TOKEN.test(token)) throw new Error("bind_invalid_token");
      const path =
        `/backend-api/conversations/${encodeURIComponent(id)}?num_turns=100&include_has_versions=true`;
      const result = await page.evaluate(
        async ({ path, headers, token, argument }) => {
          const response = await fetch(path, {
            credentials: "include",
            headers,
          });
          if (!response.ok) {
            return {
              status: response.status,
              ok: false,
              shapeSupported: true,
              hasToken: false,
            };
          }
          let detail: unknown;
          try {
            detail = await response.json();
          } catch {
            return {
              status: response.status,
              ok: false,
              shapeSupported: false,
              hasToken: false,
            };
          }
          if (
            !detail ||
            typeof detail !== "object" ||
            Array.isArray(detail) ||
            !Array.isArray((detail as { messages?: unknown }).messages)
          ) {
            return {
              status: response.status,
              ok: true,
              shapeSupported: false,
              hasToken: false,
            };
          }

          for (const raw of (detail as { messages: unknown[] }).messages) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const message = raw as {
              author?: { role?: unknown };
              recipient?: unknown;
              content?: { content_type?: unknown; text?: unknown };
            };
            if (
              message.author?.role !== "assistant" ||
              message.recipient !== "api_tool.call_tool" ||
              message.content?.content_type !== "code" ||
              typeof message.content.text !== "string"
            ) continue;
            try {
              const payload = JSON.parse(message.content.text) as {
                args?: Record<string, unknown>;
              };
              if (
                payload &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                payload.args &&
                typeof payload.args === "object" &&
                !Array.isArray(payload.args) &&
                payload.args[argument] === token
              ) {
                return {
                  status: response.status,
                  ok: true,
                  shapeSupported: true,
                  hasToken: true,
                };
              }
            } catch {
              // Unknown call payloads are not evidence.
            }
          }
          return {
            status: response.status,
            ok: true,
            shapeSupported: true,
            hasToken: false,
          };
        },
        {
          path,
          headers,
          token,
          argument: CHAT_BINDING_ARGUMENT,
        },
      );

      if (result.status === 404 || result.status === 410) return false;
      if (result.status === 401 || result.status === 403) {
        throw new Error("bind_api_auth_unavailable");
      }
      if (!result.ok) throw new Error("bind_api_conversation_unavailable");
      if (!result.shapeSupported) {
        throw new Error("bind_api_conversation_shape_unsupported");
      }
      return result.hasToken;
    },
  };
}
