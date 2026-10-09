# DevOS 2 — блокирующий release gate и безопасный rollback (#154)

Состояние на **2026-10-09:** **РЕЛИЗ ЗАБЛОКИРОВАН**. Для DevOS 2 подготовлена цепочка изолированных Staging draft PR, однако реальный E2E #150 и ChatGPT Web/iPhone MCP-плагин #151 **не приняты**. Локальный stress #152 — 73/73, полный автоматизированный прогон #149 — 520/520, но они не заменяют продуктовую приёмку. #153 содержит документацию, которую ещё надо подтвердить живым walkthrough. Никаких merge в Production, смены ngrok, замены действующей OAuth-сессии или копирования Staging state.

## Неподменяемые условия продвижения

Модуль `inspectDevos2ReleaseReadiness` проверяет исходную машинную матрицу Epic #121: **11 реальных критериев**: **9 предрелизных** по #150–153 и **2 пострелизных** по #154. До релиза проверяются только 9 обязательных E2E: требовать пострелизную проверку до выкатки означало бы невозможный замкнутый цикл. После релиза отдельный `inspectDevos2PostReleaseEvidence` проверяет два оставшихся пункта. Для каждого требуется **отдельное**, независимо подтверждённое провайдером свидетельство фактического выполнения, привязанное к **точному Git SHA релиз-кандидата**. Авторский текст модели, фиктивный `sourceRef`, зелёный fixture или устаревший head — не подтверждение.

Дополнительно требуется приватный `ProductionBackupProof`: production Git SHA и ресурс OAuth, независимо проверенный архив **config, oauth, sessions, state, browser_profile, executable**, а также действительно проверенное восстановление на отдельной тестовой копии. Нельзя публиковать пути приватного архива, API ключи, refresh токены, cookies, пароли и conversation URLs в Issue/PR.

Статус `blocked` означает, что перенос запрещён. Даже если ВСЕ подлинные проверки приняты, ответ — **`ready_for_owner_release_decision`**, но всегда `mayMerge:false`, `mayTouchProduction:false`, `mayCloseEpic:false`. После этого Main Agent предъявляет владельцу точный релиз-пакет и отдельно получает явное решение. Контракт проверки не является инструментом автоматического merge или выкладки.

Проверка текущего Staging checkout без секретов, побочных эффектов, соединения с Production и запуска browser workers:

```sh
npm run build
npx tsx --test tests/devos2-release-readiness.test.ts
npx tsx scripts/devos2-release-preflight.ts
# ОЖИДАЕМО до реальных E2E: status=blocked, exit 2
```

CLI выводит лишь ID незакрытых критериев и текущий commit, **не** приватную копию, адреса ngrok/Cloudflare и OAuth.

## Когда живые блокеры будут разрешены — последовательность V06

1. **Main Agent проверяет реальную матрицу:** оригинальный Feature SDD, Bugfix RED/GREEN и Assess через Staging ChatGPT Project; GitHub связка Issue/PR, независимый reviewer→changes_requested→rework→owner handoff, конкретный browser→Codex `needs_local_worker` и source pins. Отдельно ChatGPT Web и iPhone: native App/Safari, OAuth, отсутствие лишних authorization forms, default-deny чужого чата.
2. Зафиксировать конечные Git SHA всей stacked-цепочки и PR review; пересобрать staging-кандидат из единой проверенной базы, повторить `npm run build`, полный `npm test`, безопасный Camoufox host-smoke и сеть Staging Cloudflare. Запретить автоматическую замену оригинальных upstream SHA при сборке.
3. Отдельной локальной privileged операцией сделать **приватную зашифрованную резервную копию рабочего Production**: ветка/SHA кода, конфигурация ngrok, OAuth/refresh state, разрешения чатов, MCP tokens/client state, runner task sessions, cookies/browser profile и launcher/runtime. Сначала убедиться, что копия читается и содержит нужные элементы, затем **отдельно испытать обратное восстановление на тестовом пути**. Не архивировать секреты в Git и не переписывать Staging ими.
4. По решению владельца создать последовательность релиза с предсказуемой остановкой **только собственного Production runtime** и подтверждённым maintenance window; сохранить identity текущего Production OAuth resource и существующие пользовательские авторизации. Мигрировать **только согласованные commit/code/config transformations** — не переносить Staging порт, hostname Cloudflare, OAuth issuer/client/refresh tokens, task state или Camoufox profile вместо Production.
5. После релиза настоящий smoke: Production ngrok/MCP, ChatGPT Web+iPhone approved/unapproved chat, реальный Mac file/shell, сохранённые auth и Project conversation, отдельный browser worker grant, Codex fallback, отсутствие новых логинов без протокольной причины и отсутствие повторных карточек. Сохранить внешние доказательства в Issue/PR, не их секретное содержимое.
6. При любом критичном нарушении **остановить только принадлежащий релизу runtime**, восстановить приватные настройки и предыдущий commit/profile/session через проверенную rollback-последовательность, затем заново проверить старые Web/iPhone chat connections. Не делать `reset --hard`, `rm -rf`, реплей browser-turn или сброс OAuth без отдельного понимания последствий.
7. Только после успешной пострелизной независимой проверки Main Agent записывает фактические SHA, результаты и ограничения в #154/#121 и предлагает закрытие Epic. Даже идеально прошедшие unit tests **не** являются post-release приемкой.

## Зафиксированные технические блокеры

- **#150**: первый реальный Staging browser worker test потенциально отправил QA-сообщение, но не вернул подтверждённый terminal ответ в пределах deadline. Тот же ход не повторялся; действует локальный Staging one-shot guard. Значит, ни полный Feature, ни Bugfix, ни Assess через настоящий ChatGPT не засчитаны.
- **#151**: отдельный публичный Cloudflare Staging MCP отвечает, поддерживает OAuth discovery/PKCE и требует bearer. Но это **не** подтверждает, что отдельный Staging plugin реально подключён и работает на iPhone и ChatGPT Web.
- **#152**: 73/73 безопасных synthetic/host-local tests пройдены, но фактический end-to-end разрыв сессии и восстановление в действующем Staging ChatGPT plugin ещё не показаны.
- **#153**: русское руководство и проверенные примеры созданы; без живого user walkthrough конечная приёмка не завершена.

**Следствие:** #154 и Epic #121 остаются открыты. Производство остаётся на прежнем работающем коде и ngrok до решения реальных блокеров. Никаких ссылок/токенов на приватные состояния в публичном GitHub.
