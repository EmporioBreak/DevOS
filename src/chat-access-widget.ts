import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatAccessRegistry } from "./chat-access.js";
import { parseEnvFile } from "./connector-env.js";

export const CHAT_APPROVAL_WIDGET_URI = "ui://devos/chat-approval-v1.html";
export const CHAT_APPROVAL_WIDGET_TOOL = {
  name: "devos_authorize_chat",
  title: "Authorize this ChatGPT chat",
  description: "Show an inline password and private chat URL form. The password is submitted directly by the widget to DevOS over HTTPS; NEVER place a password into tool arguments or conversation text.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri: CHAT_APPROVAL_WIDGET_URI },
    "openai/outputTemplate": CHAT_APPROVAL_WIDGET_URI,
    securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
  },
} as const;

type Ticket = { fingerprint: string; expiresAt: number; attempts: number };
const MAX_TICKETS = 128;
const TICKET_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;

function ownerPassword(root: string, override?: string): string | undefined {
  let value = override || process.env.DEVOS_CHAT_ACCESS_PASSWORD?.trim();
  if (!value) {
    try {
      const file = parseEnvFile(readFileSync(join(root, ".env"), "utf8"));
      value = file.DEVOS_CHAT_ACCESS_PASSWORD?.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (value === undefined || value === "") return undefined;
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 1024)
    throw new Error("DEVOS_CHAT_ACCESS_PASSWORD must contain 1–1024 UTF-8 bytes");
  return value;
}

/** Ticket is bound to the fingerprint from authenticated MCP request metadata.
 * The secret never appears in MCP arguments, tool results, resources or logs.
 */
export class ChatApprovalTickets {
  private readonly pending = new Map<string, Ticket>();
  private readonly digest: Buffer | undefined;
  constructor(
    root: string,
    private readonly registry: ChatAccessRegistry,
    overridePassword?: string,
  ) {
    const password = ownerPassword(root, overridePassword);
    this.digest = password ? createHash("sha256").update(password).digest() : undefined;
  }

  issue(fingerprint: string | undefined): Record<string, unknown> {
    if (!fingerprint) return { ready: false, reason: "missing_session" };
    if (!this.digest) return { ready: false, reason: "password_not_configured" };
    const now = Date.now();
    for (const [ticket, pending] of this.pending)
      if (pending.expiresAt < now) this.pending.delete(ticket);
    if (this.pending.size >= MAX_TICKETS) return { ready: false, reason: "capacity" };
    const ticket = randomBytes(24).toString("base64url");
    this.pending.set(ticket, { fingerprint, expiresAt: now + TICKET_TTL_MS, attempts: 0 });
    return { ready: true, ticket, expires_in_seconds: Math.floor(TICKET_TTL_MS / 1000) };
  }

  approve(body: unknown): boolean {
    if (!this.digest || !body || typeof body !== "object" || Array.isArray(body))
      return false;
    const record = body as Record<string, unknown>;
    if (Object.keys(record).sort().join() !== "password,ticket,url" ||
        typeof record.ticket !== "string" || typeof record.password !== "string" ||
        typeof record.url !== "string" || record.url.length > 1024 ||
        Buffer.byteLength(record.password, "utf8") > 1024)
      return false;
    const ticket = this.pending.get(record.ticket);
    if (!ticket) return false;
    if (ticket.expiresAt <= Date.now() || ticket.attempts >= MAX_ATTEMPTS) {
      this.pending.delete(record.ticket);
      return false;
    }
    ticket.attempts++;
    const candidate = createHash("sha256").update(record.password).digest();
    if (!timingSafeEqual(this.digest, candidate)) {
      if (ticket.attempts >= MAX_ATTEMPTS) this.pending.delete(record.ticket);
      return false;
    }
    // Consume the one-time ticket, even if the URL is invalid or conflicts.
    this.pending.delete(record.ticket);
    try {
      this.registry.approve(ticket.fingerprint, record.url);
      return true;
    } catch {
      return false;
    }
  }
}

/** Inline MCP Apps HTML. Never use a model-visible tool call to submit passwords. */
export function chatApprovalWidget(origin: string): string {
  const endpoint = JSON.stringify(new URL("/chat-access/approve", origin).href).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px system-ui,sans-serif;margin:0;padding:16px;color:inherit}
h3{font-size:16px;margin:0 0 10px}
label{display:block;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #888;border-radius:9px;background:transparent;color:inherit}
button{font:inherit;font-weight:600;padding:10px 14px;margin-top:14px;border:1px solid #888;border-radius:10px;background:transparent;color:inherit}
#message{white-space:pre-wrap;margin-top:12px;min-height:16px}
small{color:inherit;opacity:.75}
</style></head>
<body>
<h3>DevOS — разрешить этот чат</h3>
<small>Пароль отправляется напрямую в DevOS по HTTPS и не передаётся модели. Только владелец может разрешать чаты.</small>
<form id="auth">
<label for="chaturl">Приватная ссылка на текущий чат</label>
<input id="chaturl" type="url" inputmode="url" autocomplete="off" spellcheck="false"
  required placeholder="https://chatgpt.com/c/…" />
<label for="password">Пароль авторизации DevOS</label>
<input id="password" type="password" autocomplete="off" required />
<button id="go" type="submit">Разрешить этот чат</button>
</form>
<div id="message" role="status" aria-live="polite"></div>
<script>
"use strict";
const endpoint = ${endpoint};
const out = document.getElementById("message");
const form = document.getElementById("auth");
let activeTicket = null;
function readToolOutput() {
  const payload = window.openai?.toolOutput;
  if (!payload) return null;
  if (payload.structuredContent && typeof payload.structuredContent === "object")
    return payload.structuredContent;
  if (payload.content?.[0]?.text) {
    try { return JSON.parse(payload.content[0].text); } catch {}
  }
  if (payload.ticket || payload.reason) return payload;
  return null;
}
function refresh() {
  const result = readToolOutput();
  if (!result) { out.textContent = "Ожидаем ответ DevOS…"; return; }
  if (!result.ready) {
    activeTicket = null;
    form.hidden = true;
    out.textContent = result.reason === "missing_session"
      ? "ChatGPT не передал идентификатор этой беседы. Доступ закрыт."
      : result.reason === "password_not_configured"
      ? "Для виджета ещё не настроен отдельный пароль на Mac."
      : "Сейчас невозможно открыть подтверждение. Повтори вызов инструмента.";
    return;
  }
  activeTicket = result.ticket;
  out.textContent = "Готово к подтверждению. Запрос действует 5 минут.";
}
refresh();
window.addEventListener("openai:set_globals", refresh);
form.addEventListener("submit", async function(event) {
  event.preventDefault();
  if (!activeTicket) { out.textContent = "Нет действующего запроса авторизации."; return; }
  const input = document.getElementById("password");
  const password = input.value;
  input.value = ""; // Clear immediately; never store in widgetState, tool arguments or messages.
  const url = document.getElementById("chaturl").value.trim();
  const button = document.getElementById("go");
  button.disabled = true;
  out.textContent = "Проверяем пароль в DevOS…";
  try {
    const response = await fetch(endpoint, {
      method: "POST", mode: "cors", credentials: "omit",
      cache: "no-store", referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket: activeTicket, url, password })
    });
    if (!response.ok) {
      out.textContent = "Не удалось авторизовать чат. Проверь ссылку и пароль. После нескольких попыток вызови инструмент снова.";
      return;
    }
    const result = await response.json();
    if (!result.approved) throw new Error("approval failed");
    activeTicket = null;
    form.hidden = true;
    out.textContent = "Чат разрешён. DevOS-инструменты доступны в этой беседе.";
  } catch {
    out.textContent = "Нет связи с DevOS. Пароль не сохранён — повтори попытку.";
  } finally { button.disabled = false; }
});
</script></body></html>`;
}
