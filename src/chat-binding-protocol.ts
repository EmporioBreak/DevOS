import { randomUUID } from "node:crypto";

export const CHAT_BINDING_ARGUMENT = "_devos_binding_token";
export const CHAT_BINDING_TOKEN = /^DEVOS_BIND_[A-Za-z0-9_-]{12,128}$/;

export function createChatBindingToken(): string {
  return `DEVOS_BIND_${randomUUID().replaceAll("-", "")}`;
}

export function addChatBindingTokenToTool(
  tool: Record<string, unknown>,
  token: string,
): Record<string, unknown> {
  if (!CHAT_BINDING_TOKEN.test(token)) throw new Error("bind_invalid_token");
  const rawSchema = tool.inputSchema;
  const schema =
    rawSchema && typeof rawSchema === "object" && !Array.isArray(rawSchema)
      ? structuredClone(rawSchema as Record<string, unknown>)
      : { type: "object" };
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? { ...(schema.properties as Record<string, unknown>) }
      : {};
  if (CHAT_BINDING_ARGUMENT in properties) {
    throw new Error("Desktop Commander tool conflicts with DevOS binding argument");
  }
  properties[CHAT_BINDING_ARGUMENT] = {
    type: "string",
    const: token,
    default: token,
    description: "Internal DevOS conversation-correlation token. Pass exactly as provided.",
  };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  if (!required.includes(CHAT_BINDING_ARGUMENT)) required.push(CHAT_BINDING_ARGUMENT);
  return {
    ...tool,
    inputSchema: {
      ...schema,
      type: "object",
      properties,
      required,
    },
  };
}

export function stripChatBindingTokenFromCall(
  request: unknown,
  expectedToken: string,
): unknown {
  if (!CHAT_BINDING_TOKEN.test(expectedToken)) throw new Error("bind_invalid_token");
  if (!request || typeof request !== "object" || Array.isArray(request)) return request;
  const call = request as {
    method?: string;
    params?: { arguments?: Record<string, unknown>; [key: string]: unknown };
    [key: string]: unknown;
  };
  if (call.method !== "tools/call") return request;
  const args = call.params?.arguments;
  if (!args || args[CHAT_BINDING_ARGUMENT] !== expectedToken) {
    throw new Error("bind_token_missing_or_mismatched");
  }
  const forwarded = { ...args };
  delete forwarded[CHAT_BINDING_ARGUMENT];
  return {
    ...call,
    params: {
      ...call.params,
      arguments: forwarded,
    },
  };
}

export function conversationContainsChatBindingToken(
  conversation: unknown,
  token: string,
): boolean {
  if (!CHAT_BINDING_TOKEN.test(token)) return false;
  if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) return false;
  const messages = (conversation as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;

  for (const raw of messages) {
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
        payload.args[CHAT_BINDING_ARGUMENT] === token
      ) return true;
    } catch {
      // Unknown payload shapes are not binding evidence.
    }
  }
  return false;
}
