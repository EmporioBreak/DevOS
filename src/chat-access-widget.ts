import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChatAccessRegistry } from "./chat-access.js";
import { parseEnvFile } from "./connector-env.js";

export const CHAT_APPROVAL_WIDGET_URI = "ui://devos/chat-approval-v2.html";
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
<small>Принимаются ссылки /c/ и /share/ из мобильного ChatGPT. Ссылка /share/ публичная: доступ к Mac определяется паролем и MCP-сессией, а не владением этой ссылкой. Пароль отправляется напрямую в DevOS.</small>
<form id="auth">
<label for="chaturl">Ссылка на чат из ChatGPT</label>
<input id="chaturl" type="url" inputmode="url" autocomplete="off" spellcheck="false"
  required placeholder="https://chatgpt.com/share/… или /c/…" />
<label for="password">Пароль авторизации DevOS</label>
<input id="password" type="password" autocomplete="off" required />
<button id="go" type="submit">Разрешить и продолжить</button>
</form>
<div id="message" role="status" aria-live="polite"></div>
<script>
"use strict";
const endpoint = ${endpoint};
const out = document.getElementById("message");
const form = document.getElementById("auth");
let activeTicket = null;

// Prefer the standard MCP Apps bridge. On some native iOS releases the
// ChatGPT compatibility alias sendFollowUpMessage resolves without actually
// continuing the chat. ui/message is the portable, acknowledged alternative.
// Negotiate before the user submits; never try BOTH transports for one grant.
const pendingBridge = new Map();
let bridgeReady = false;
let standardToolOutput = null;
let bridgeRequestId = 0;
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
  const message = event.data;
  if (message.method === "ui/notifications/tool-result") {
    standardToolOutput = message.params?.structuredContent || null;
    refresh();
    return;
  }
  if (!pendingBridge.has(message.id)) return;
  const pending = pendingBridge.get(message.id);
  pendingBridge.delete(message.id);
  clearTimeout(pending.timer);
  if (message.error) pending.reject(new Error("Host rejected MCP Apps request"));
  else pending.resolve(message.result);
});
function bridgeRequest(method, params, timeoutMs) {
  const id = "devos-approval-" + (++bridgeRequestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBridge.delete(id);
      reject(new Error("Host MCP Apps bridge unavailable"));
    }, timeoutMs);
    pendingBridge.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}
// Handshake result, not the presence of postMessage, proves standard support.
void bridgeRequest("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "devos-chat-approval", version: "2.0.0" },
  appCapabilities: { availableDisplayModes: ["inline"] }
}, 2500).then(() => {
  bridgeReady = true;
  window.parent.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/initialized"
  }, "*");
}).catch(() => { /* ChatGPT compatibility globals may still be available. */ });

function readToolOutput() {
  if (standardToolOutput) return standardToolOutput;
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
  if (result.approved === true || result.reason === "already_authorized") {
    activeTicket = null;
    form.hidden = true;
    out.textContent = "Доступ DevOS уже разрешён для этого чата.";
    return;
  }
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
    out.textContent = "Доступ разрешён. Передаём подтверждение в ChatGPT…";
    // The initial Mac operation was denied and never queued. The host alone
    // decides whether to start the original workflow in a new model turn.
    // Never forward a password, a ticket or a conversation URL to the model.
    const resumePrompt = "Доступ DevOS к этому чату успешно подтверждён. Без дополнительных вопросов продолжи последнее запрошенное мной действие с DevOS/Desktop Commander. Не повторяй авторизацию.";
    try {
      if (bridgeReady) {
        // Standard MCP Apps request provides explicit success/error response.
        await bridgeRequest("ui/message", {
          role: "user", content: [{ type: "text", text: resumePrompt }]
        }, 5000);
      } else if (typeof window.openai?.sendFollowUpMessage === "function") {
        // Use compatibility path only if the standard handshake did NOT work.
        await window.openai.sendFollowUpMessage({
          prompt: resumePrompt, scrollToBottom: true
        });
      } else {
        throw new Error("No host continuation capability");
      }
      out.textContent = "Подтверждение отправлено в ChatGPT. Ожидаем продолжения исходного запроса…";
    } catch {
      // Do not retry through the other method after sending: an ack can be
      // lost even if the host started processing, causing duplicate actions.
      out.textContent = "Доступ разрешён, но ChatGPT не подтвердил продолжение. Если ответ не появится, повтори исходный запрос один раз.";
    }
  } catch {
    out.textContent = "Нет связи с DevOS. Пароль не сохранён — повтори попытку.";
  } finally { button.disabled = false; }
});
</script></body></html>`;
}

/** Browser fallback for native ChatGPT clients that skip MCP Apps resources/read.
 * The one-time ticket lives in the URL fragment, not the HTTPS request path,
 * query string, Referer or server logs. No OAuth token or cookie is involved. */
export function externalChatApprovalForm(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Разрешить DevOS для этого чата</title>
<style>body{font:16px system-ui,sans-serif;max-width:420px;margin:32px auto;padding:0 20px}
label{display:block;margin-top:16px}input{font:inherit;width:100%;box-sizing:border-box;padding:12px}
button{font:inherit;padding:12px;margin-top:20px}p{line-height:1.5}</style></head>
<body><h2>Разрешить DevOS для этого чата</h2>
<p>Форма открыта на сервере DevOS. Пароль отправляется только в DevOS;
публичная ссылка /share/ — лишь метка. Доступ привязан к MCP-сессии
чата, в котором ты вызвал инструмент.</p>
<form id="auth"><label>Ссылка на чат (/c/ или /share/)
<input type="url" id="url" autocomplete="off" required placeholder="https://chatgpt.com/share/…"></label>
<label>Пароль DevOS<input type="password" id="password" autocomplete="off" required></label>
<button id="submit" type="submit">Разрешить этот чат</button></form>
<p id="status" role="status" aria-live="polite"></p>
<script>
"use strict";
const ticket = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const form = document.getElementById("auth");
const status = document.getElementById("status");
if (!/^[a-zA-Z0-9_-]{32}$/.test(ticket)) {
  form.hidden = true;
  status.textContent = "Недействительный запрос. Повтори действие в ChatGPT.";
}
form.addEventListener("submit", async event => {
  event.preventDefault();
  const passwordInput = document.getElementById("password");
  const password = passwordInput.value;
  passwordInput.value = "";
  const url = document.getElementById("url").value.trim();
  const btn = document.getElementById("submit");
  btn.disabled = true;
  try {
    const response = await fetch("/chat-access/approve", {
      method:"POST", credentials:"omit", cache:"no-store", referrerPolicy:"no-referrer",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ticket,password,url})
    });
    if (!response.ok) { status.textContent="Доступ не разрешён. Проверь пароль и ссылку."; return; }
    form.hidden = true;
    status.textContent="Доступ разрешён! Вернись в ChatGPT и повтори исходный запрос. Встроенная форма ChatGPT на iOS может не поддерживаться.";
  } catch {
    status.textContent="Не удалось связаться с DevOS. Повтори попытку.";
  } finally { btn.disabled=false; }
});
</script></body></html>`;
}
