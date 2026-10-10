# DevOS 2 — руководство по разработке и эксплуатации

Это руководство по **уже развёрнутой в Production DevOS 2** в рамках Epic #121. Рабочая установка обновлена владельцем 2026-10-10; актуальный Production Git SHA сверяйте с `git rev-parse HEAD`, а не с историческим коммитом первого развёртывания. **Полная E2E-приёмка всё ещё открыта:** реальные ChatGPT Web/iPhone, неавторизованный чужой чат и полный browser-worker feature/bugfix/assess не подтверждены. Наличие собранного кода и положительный transport-smoke не означает принятую функциональность.

## 1. Принцип и состав системы

**DevOS** объединяет DevOS Main Agent, оригинальный GitHub Spec Kit, методы Superpowers, DevOS Skills Library, существующий DevOS Runner, DevOS MCP и GitHub. **Runner — только исполнитель заранее согласованной одной GitHub Issue**; он не заменяет Main Agent и не содержит второго Spec Kit workflow engine.

В нормальном проекте пользователь сначала обсуждает с Main Agent результат, альтернативы, границы и критерии. Архитектурные решения и существенные изменения scope обсуждаются **до** выполнения, без серии повторных согласований внутри утверждённой задачи. Main Agent получает подлинное подтверждение пользователя и привязывает его к точной версии оригинальных Spec Kit артефактов и полного worker graph; одна лишь строка `userMessageRef` в JSON не является доказательством.

Миграция Epic #121 выполнялась Main Agent **напрямую в изолированных Git worktrees и через draft PR**, не поручая построение DevOS 2 самому Runner. По решению владельца DevOS 2 уже развёрнут на Production (Git SHA `650865bc`, 2026-10-10), исходный ngrok и общий Camoufox сохранены; отдельный тестовый MCP отключён. **Не путайте факт развёртывания с E2E-приёмкой:** Web/iPhone и независимые worker-сценарии остаются неподтверждёнными в #150–154. Для новых задач действует обычный Runner.

## 2. Новый Feature / приложение

Пример: «Сделай поиск в приложении, который остаётся полезным офлайн».

1. Main Agent уточняет цели, предлагает варианты — локальный индекс против облачного поиска — и вместе с пользователем выбирает границы. Superpowers `devos-brainstorming` помогает найти дизайн; `devos-writing-plans` детализирует **исходный** план Spec Kit, но не создаёт второй.
2. Использует первоначально ратифицированную пользователем оригинальную Spec Kit **Constitution** проекта. Для Feature запускает **оригинальные** `speckit-specify → speckit-clarify (при необходимости) → speckit-plan → speckit-checklist (при необходимости) → speckit-tasks → speckit-analyze (при необходимости)`. Результат — **один** канонический `spec.md`, `plan.md` и `tasks.md`; оригинальные микро-шаги `T001...` не превращаются автоматически каждый в GitHub Issue.
3. Для крупной функции создаёт Epic с независимо проверяемыми Issues и зависимостями; для небольшой — одну Issue. Каждая реализационная Issue указывает текущий **Git commit** спецификации, linked PR, product acceptance, роль/executor/сессию, а также полный неизменный граф воркеров.
4. Перед Runner Main Agent независимо проверяет scope/spec/plan approval, назначенные навыки и точные pinned SHA; сохраняет **HMAC-подписанный** граф и manifests для всех будущих воркеров.
5. **Runner одной Issue** вызывает назначенного `chatgpt_browser` разработчика в отдельном Project-чате; проверяет сохранённую identity и отдаёт оригинальный `speckit-implement`, совместимые Superpowers TDD и debugging. Если конкретная локальная возможность недоступна, только тогда `needs_local_worker` маршрутизирует на заранее объявленного `codex`; на нём навыки устанавливаются как native pinned files.
6. Независимый reviewer проверяет diff, тесты и GitHub PR. `changes_requested` возвращает разработчика в **тот же PR и сохранённую ChatGPT conversation**. Оригинальный `speckit-converge` может лишь дописать недостающие `Txxx` в конец канонического `tasks.md`. Завершённый Converge — не owner acceptance.
7. Runner выдаёт `DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED",...}`. Main Agent сам сверяет текущие Issue/PR/head, спецификацию и тестовое evidence. `approved` означает его явное решение, `changes_requested` продолжает ту же задачу. Merge/релиз остаётся отдельным решением.

**Важно:** проверки contracts и synthetic worker fixture уже существуют; описанный полный браузерный цикл *ещё не подтверждён живым E2E* (#150).

## 3. Исправить дефект — Bugfix, без фиктивного Feature

Пример: «Запрос с отсутствующим токеном падает TypeError».

Оригинальное расширение GitHub Spec Kit **Bugfix**: `speckit.bug.assess → speckit.bug.fix → speckit.bug.test`. Канонические файлы: `.specify/bugs/<slug>/assessment.md`, `fix.md`, `test.md`.

**Assess** должен воспроизвести симптом и назвать настоящую причину прежде чем менять код. **Fix** делает минимальный scoped patch и регрессионный тест — RED перед исправлением, GREEN после. **Test** повторяет исходный reproducer и независимые проверки и честно возвращает `verified`, `partial` либо `failed`, не заменяя их текстом «вроде починил». Расширение scope возвращается Main Agent на новое согласование. PR и reviewer работают в той же Issue, а последний verdict остаётся за Main Agent.

Реальная временная локальная Node/Git fixture с падением, фиксом и тестами проверена в [#131](https://github.com/EmporioBreak/DevOS/issues/131). Это не означает, что настоящий browser worker уже прошёл live Bugfix E2E #150.

## 4. Оценить идею — Assess, без разработки

Пример: «Есть ли смысл добавлять офлайн-поиск?».

Оригинальное расширение **Spec Kit Assess**: `speckit.assess.intake → speckit.assess.research → speckit.assess.define → speckit.assess.shape → speckit.assess.decide`. Файлы: `.specify/assessments/<slug>/intake.md`, `research.md`, `problem.md`, `concept.md`, `decision.md`. `intake` и `research` допустимо пропускать в исследовательском сценарии; `go` требует достаточно достоверных данных и сформированного варианта. Обязательно учитываются риск, стоимость бездействия, источники «за» и «против». Предположения остаются **ASSUMPTION**, а не выдуманными ссылками.

`kill` и `needs-clarification` — нормальные исходы. Даже `go` **не создаёт автоматически Issue, PR или Runner**: Main Agent отдельно обсуждает с владельцем Feature scope и только после согласования запускает обычный SDD-маршрут.

Тестовые оригинальные Assess artifacts и решение без кода проверены в [#132](https://github.com/EmporioBreak/DevOS/issues/132), реальный ChatGPT Assess E2E всё ещё открыт #150.

## 5. Как читать и менять навыки

Реестр с version/hash/source находится в `config/devos-skills.json`; правила — в Git-backed `config/devos-skill-policy.json`; immutable upstream lock — `config/devos-upstreams.lock.json`. Библиотека принимает ноль, один или несколько совместимых навыков. Режимы **required/optional/off**:

- `required` — обязательно, недоступный или конфликтующий источник полностью **блокирует** запуск.
- `optional` — выбирается Main Agent при необходимости; совместимый активируется, отклонённый записывается в `skipped` с причиной.
- `off` — жёстко запрещён для данного scope.

Приоритет: **task → role → project → global**. Изменение во время активной Issue не меняет уже подписанный manifest. Смена версии требует обновления pinned источника, проверки всех assets и отдельного reviewed update, а не замены файла `SKILL.md` под тем же version.

Примеры настоящих **read-only CLI** на установленном Production (из корня рабочего DevOS checkout; команды проверены на действующем `main` 2026-10-10):

```sh
./devos skills status
./devos skills issue EmporioBreak/DevOS 153 developer developer execution implement superpowers-test-driven-development
```

Первый на реальном Production вернул 17 установленных навыков, 0 недоступных, 0 ошибок целостности и две pinned upstream базы. Второй **выполнен** для Issue #153 в read-only режиме: вернул `currentIssue` и verified effective profile с одним выбранным навыком, не запускал Runner или browser worker. Это диагностика, не разрешение исполнять произвольную задачу и не настоящая проверка browser E2E. Для предварительного сравнения зарегистрированного навыка с локальным candidate JSON:

```sh
./devos skills preview superpowers-test-driven-development path/to/candidate.json
```

Последняя команда — **preview, не изменение/установка**. Идея обновления затем идёт в reviewed Git commit/PR. Писать в `config` напрямую без expected fingerprint опасно.

В уже авторизованном owner-чате соответствующего подключённого DevOS MCP:

```text
devos_skill_policy_get({})
devos_skill_policy_set({skill_id, mode, scope, context?, expected_fingerprint})
devos_skill_diagnostics({})
devos_pipeline_status({repo, issue})
```

`devos_skill_policy_get/set` требуют авторизацию **конкретного чата** (а не просто OAuth клиента). `devos_pipeline_status` показывает owner-only sanitized timeline, signed skills, stage и причины отсутствующих optional; ни токены, ни saved ChatGPT URL не публикуются. Browser workers получают лишь свои исходные навыки через `devos_skill_manifest/search/read` при **server-verified grant**. Никакое утверждение модели «я reviewer» не даёт права доступа.

## 6. Runner, Production, повторы и диагностика

Только когда Main Agent уже зафиксировал полный graph и получил настоящие approvals, existing Runner можно вызывать из project-local checkout:

```sh
./devos run .devos/workflow.json
```

Обычный `run` возобновляет текущую Issue. `restart` — **намеренное** перепланирование и сброс state только этой Issue; не используйте его как автоматический retry неопределённого browser-turn. В DevOS 2 `skillsMode: "strict"` указывает на обязательный owner-signed graph/worker manifests; старые workflow без этого поля продолжают работать без breaking API.

Имена машинных статусов worker: `done`, `approved`, `changes_requested`, `needs_local_worker`, `failed`. Финальная задача возвращает `final_review_required`; это ещё не `completed`. Browser may-have-submitted **никогда** не отправляется повторно лишь потому, что SSE или MCP отчёт оборвались. Точный URL ранее созданного Project-чата сохраняется, нельзя заменять его новым разговором «на глазок».

**Рабочий режим с 2026-10-10 — только Production MCP:** ngrok и MCP на локальном порту :8787. Отдельный Staging MCP/Cloudflare :8788 **отключён по решению владельца**, не запускать его ради тестов. Существующий Camoufox профиль общий; не разделять, не заменять, не очищать cookies/OAuth. Успех HTTP 200/401 или обычного Mac tool в текущем чате не доказывает работу другого ChatGPT-чата или iPhone. Старые Staging-документы оставлены как история, а не инструкция по запуску.

**Production-only проверка на работающем Mac**, без отправки ChatGPT turn и без изменений OAuth/браузера:

```sh
# Выполнять из чистого Production checkout; только чтение/HTTP отрицательные запросы
node scripts/devos2-production-postrelease.smoke.mjs

# Проверки исходников и безопасный synthetic stress — из отдельной worktree
# c установленными node_modules, НЕ в рабочем checkout
./node_modules/.bin/tsx --test tests/acceptance-matrix.test.ts
./node_modules/.bin/tsx scripts/devos2-production-safe-chaos.smoke.ts \
  /path/to/Production-DevOS /path/to/isolated-DevOS-worktree
```

Первый скрипт реально прошёл **13/13** HTTP/auth-negative/checkout/profile-presence критериев. Второй — **73/73** синтетических тестов и временный browser lifecycle smoke; он не открывает реальные чаты и не использует Production профиль. Рабочий MCP остаётся на месте. Не запускать старые `staging-*` скрипты, ожидающие работающий порт 8788.

**Отдельное наблюдение через реальный ChatGPT MCP:** в существующем разрешённом owner-чате выполнены успешные `write_file → read_file → start_process` для случайно названного временного файла, точная строка совпала, файл удалён. После этого `devos_noop` вернул `approved=true` без повторной авторизации, Production `/health` сохранил HTTP 200. Это подтверждает цепочку **текущий ChatGPT-чат → Production MCP → Mac**, но не интерфейс iPhone, не другой чат и не browser-worker grant. На практике проверка должна выполняться с новым одноразовым именем, без паролей и без изменения рабочих файлов.

Исторически на Staging было **520/520 PASS** (#149); после Production deployment прогон регрессий в изолированной worktree — **575/575 PASS**, а Production-only synthetic stress — **73/73 PASS** (#152). Настоящий Camoufox открыл ChatGPT Project и показал composer, но первый отправляемый QA-turn #150 завершился по deadline после потенциальной отправки. Локальный one-shot marker запрещает опасный повтор. **Не запускайте тестовый prompt повторно** просто ради зелёного отчёта; точная проверка возможна лишь при доказанной идентичности того же хода. ChatGPT iPhone plugin/authorization App ещё не принят (#151).

## 7. FAQ и восстановление

**Нужно ли давать пароль на каждый новый чат?** Нет. MCP default-deny разрешает данные Mac лишь после on-demand авторизации *конкретного* чата. У одобренного разговора повторные обычные вызовы не должны открывать ещё одну App-форму. Сведения о чужом чате с тем же OAuth токеном не должны становиться доступны. Если inline App не рендерится на iPhone, используйте Safari fallback URL, выданный **самим инструментом авторизации** для текущего чата; никогда не публикуйте пароль или ticket в GitHub.

**Почему браузерный Codex не запустился при сложной задаче?** Сложность не основание для fallback. Нужен настоящий browser attempt, конкретный host blocker, статус `needs_local_worker` и заранее записанный Codex worker; если граф не содержит этого пути, Runner fail-closed.

**Можно ли взять upstream Superpowers как есть?** Если он требует собственные subagents, Git branching, автоматический merge, rival review orchestration или отдельный план — нет. Сохраняйте immutable upstream и назначайте проверенный `devos-*` вариант с отдельной атрибуцией/commit pin.

**Почему зелёные тесты не означают полную приёмку?** Автоматические fixture callbacks не доказывают настоящую пользовательскую авторизацию чужого чата, ChatGPT Mobile App или GitHub review. DevOS 2 **уже работает в Production**, однако матрица `config/devos-v2-acceptance-matrix.json` отделяет синтетическое покрытие от обязательных живых проверок #150–154. До их подтверждения Epic #121 не закрывать и не считать продукт полностью принятым.

**Как откатывать?** Зафиксировать проверенный Production Git SHA и его наличие на GitHub; при проблеме вернуть исходный код к нему с сохранением `.env`, `.devos`, OAuth/worker state и фактического Camoufox-профиля. Не переносить Staging secrets, профиль и URL в Production. Владелец допускает повторную штатную авторизацию ChatGPT/MCP (обычно несколько минут), поэтому создание полного приватного backup/restore не является обязательным условием релиза; PR #206 необязателен и исключён из release stack. Git rollback **не** восстанавливает cookie, OAuth или состояние задач, если они были повреждены: предварительно исключить их удаление/перезапись из процедуры. Не применять `reset --hard`/`rm -rf` как шаг по умолчанию и не публиковать секреты. Реальный Web/iOS smoke и проверка авторизации остаются обязательными.

Дальнейшие технические контракты: [Runner и Skills](runner-skill-integration.md), [политика выбора](skill-policy.md), [оригинальный Spec Kit](spec-kit-predevelopment.md), [Bugfix](spec-kit-bugfix.md), [Assess](spec-kit-assessment.md), [матрица приёмки](devos-v2-verification-matrix.md), [реальный Staging blocker](live-staging-e2e-readiness.md), [безопасная диагностика browser-worker grant](worker-authorization-live-runbook.md), [MCP Web/iOS ограничения](staging-plugin-transport-readiness.md).

Реальные read-only проверки установленного Production см. в [release gate](devos2-release-gate.md) и `scripts/devos2-production-postrelease.smoke.mjs`.
