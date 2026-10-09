# DevOS 2 — отдельный staging через Cloudflare

Production остаётся на ngrok и обычных командах `./devos connector ...`.
В staging используется отдельный Git clone, скопированные `.devos`/`.env`
и собственный профиль `~/.devos-staging/camoufox-profile`.

## Настройка Staging

Требуется установленный официальный `cloudflared` в PATH.
В игнорируемом Git файле `.devos/connector/config.json`:

```json
{"version":1,"gatewayPort":8788,"ngrokApiPort":4042,"tunnel":"cloudflare"}
```

Команды из каталога staging:

```sh
./devos-staging connector doctor
./devos-staging connector start
./devos-staging connector status
./devos-staging connector stop
```

`devos-staging` выбирает скопированный Camoufox profile через
`DEVOS_BROWSER_PROFILE_DIR`. Эти команды не выполняются в Production.
Cloudflare открывает временный HTTPS-URL `https://*.trycloudflare.com/mcp`.
OAuth, PKCE и default-deny MCP-гейт остаются обязательными.
## Ограничения и проверки

- **Quick Tunnel — только для тестов:** hostname меняется при restart,
  нет uptime guarantee и Cloudflare заявляет отсутствие поддержки SSE.
  Поэтому HTTP 200 `/health` ещё не подтверждает работу StreamableHTTP MCP
  внутри ChatGPT. Для постоянного подключения понадобится отдельный
  проверенный Cloudflare Tunnel со стабильным hostname и SSE-тестами.
- OAuth bearer-state DevOS привязан к точному публичному `/mcp` адресу.
  Скопированные данные сохраняются, но ранее выданные ngrok tokens могут
  потребовать OAuth-consent на новом Cloudflare URL: не стираем их заранее.
- `connector doctor` не проверяет публичную сеть; status — только локальное
  состояние. Для external check нужен запрос к реальному Cloudflare URL.
- Без `tunnel` настройка продолжает использовать ngrok по умолчанию;
  рабочий Production не меняем.
- Не коммитить `.env`, `.devos`, OAuth token-state и Camoufox profiles.

## Проверка, проведённая на Staging

- Два локальных gateway слушали разные порты: 8787 Production и 8788 Staging.
- `staging /health`: HTTP 200, `oauthReady=true`, `backendAlive=true`.
- Cloudflare `/health`: HTTP 200.
- Cloudflare OAuth discovery: HTTP 200.
- Cloudflare `/mcp` без bearer: HTTP 401 (ожидаемое закрытие).
- Полноценный ChatGPT plugin / потоковый MCP / iPhone: ещё не проверены.
