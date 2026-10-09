# DevOS 2 — архитектурный контракт

Статус: целевая архитектура, согласованная владельцем 2026-10-09. Главный Epic:
[EmporioBreak/DevOS#121](https://github.com/EmporioBreak/DevOS/issues/121).
Эта документация **не утверждает**, что описанные ниже функции уже реализованы:
раздел «Текущее состояние» отделяет код от целевых возможностей.

## Названия и ответственность

**DevOS — целостная интеллектуальная система автономной разработки ПО**, от
обсуждения идеи и спецификации до реализации, проверки и финальной приёмки.
Называть всю систему «тупым оркестратором» неверно.

| Компонент | Ответственность | Не делает |
| --- | --- | --- |
| DevOS Main Agent | Обсуждение с владельцем, дизайн и решения, Spec Kit stages, Epic, Issues, зависимости, назначение skills/ролей, конечная приёмка | Не меняет согласованный scope тайно и не делегирует финальную приёмку |
| DevOS Runner | Линейно исполняет **одну Issue** через заранее объявленные воркеры и routes, сохраняет сессии, обрабатывает status/recovery | Не создаёт Issues, Epic, worker roles или product judgments |
| Spec Kit | Официальный неизменённый SDD, Bugfix и Assess, источники spec/plan/tasks | Не запускает конкурирующий workflow engine |
| Superpowers | Методы brainstorming, детального планирования, TDD, debugging, обработки review и verification | Не запускает subagents, не владеет Git/worktrees |
| DevOS Skills Library | Git-backed каталог оригиналов и адаптаций, версии, целостность, required/optional/off, раздача навыков | Не переназначает workers во время исполнения |
| DevOS MCP | Локальные инструменты, доступ ChatGPT и защита от неавторизованных чатов | Не решает, как строить продукт |
| GitHub | Истина по Epic/Issue/PR, contract, статусам и проверкам; трассируемые ссылки на Spec Kit артефакты | Не хранит секреты и приватные browser profiles |

Существующие названия CLI `devos run`, `devos restart`, статусы и основные
протоколы сохраняются. «DevOS Runner» — имя исполнительного компонента, а
не повод немедленно ломать публичный интерфейс CLI.

## От запроса пользователя до результата

1. **Main Agent / Predevelopment.** Классифицирует запрос как новую
   функциональность, bounded change, bugfix или assessment. Обсуждает цель,
   дизайн, варианты и ограничения, получает содержательные согласования
   **до** реализации. Не требует подтверждений на каждом внутреннем шаге.
2. **Spec Kit / planning.** Для feature: `constitution` (принципы проекта,
   не повторять без необходимости) → `specify` → `clarify?` →
   `plan` → `checklist?` → `tasks` → `analyze?`. При пробелах
   возвращается на стадию, которой принадлежат артефакты. Анализ read-only,
   custom quality checklist не самозаверяется разработчиком.
3. **Main Agent / GitHub.** Создаёт одну проверяемую Issue или Epic + DAG
   независимых Issues, связывает canonical Spec Kit artifacts и commits.
   Microtasks `T001` не обязаны соответствовать отдельным Issues.
   Выбирает skills и заранее объявляет полную схему воркеров **для каждой
   Issue** (включая заранее определённый fallback и reviewer).
4. **Skills / preflight.** Resolves версии и priority, проверяет
   существование ресурсов, SHA-256 и несовместимые инструкции до Runner.
   Работник получает только выбранные `required/optional` skills;
   `off` не активируется, отсутствие `required` — явный блокер.
5. **Runner / одна Issue.** Запускает заранее объявленных ChatGPT browser
   workers в заданном графе; при реально обнаруженной недоступной локальной
   возможности `needs_local_worker` направляет в заранее объявленный
   Codex fallback. Тот же worker в той же задаче → та же сохранённая
   сессия, новая задача → новая conversation внутри настроенного Project.
6. **Implement / correction.** Оригинальный `speckit-implement` читает
   согласованные tasks. Совместимые Superpowers TDD/debugging/review/
   verification применяются к исполнению. Reviewer независимо проверяет;
   его `changes_requested` возвращает тому же dev worker/PR. Оригинальный
   `speckit-converge` append-only фиксирует оставшиеся gaps в tasks,
   не выдавая «approved» автоматически.
7. **Main Agent / final judgment.** `FINAL_REVIEW_REQUIRED` возвращает
   original Issue, head PR/diff, reports и test evidence на независимую
   проверку Main Agent. `changes_requested` продолжает прежнюю задачу,
   граф, PR и сессии; `approved` завершает её. Merge/deploy — отдельный
   release gate, не полномочие worker skills.

Для bugfix и assess доступны оригинальные официальные сценарии Spec Kit
с пошаговым вызовом компонентных skills, **без второго execution engine**.
Чистый assessment не требует создания кода, PR или Runner, если
пользователь заказал только оценку.

## Единственная истина о требованиях

- GitHub Epic управляет программой и межзадачными зависимостями.
- GitHub Issue определяет самостоятельный, проверяемый контракт задачи,
  linked PR и результат приёмки.
- Оригинальные Spec Kit `spec.md`, `plan.md`, `tasks.md`,
  `constitution` — **единственная** source of truth для feature
  specifications и implementation tasks. GitHub ссылается на них по пути
  и неизменяемому Git SHA/версии.
- `devos-writing-plans` обогащает Spec Kit план/задачи интерфейсами,
  точными файлами, test-first действиями и проверками, но не создаёт
  конкурирующий `docs/superpowers/plans/*`.
- Runtime state Runner, OAuth state и данные browser profile остаются
  **локальными**, за пределами публичного GitHub.
- Spec Kit Git Extension/Agent Context работают в рамках DevOS Git и
  per-worktree контекста, не создают ветки или auto-commits за спиной
  главного агента.
- Original Spec Kit Bundles, Artifact CLI, Event CLI доступны; Presets не
  активируются. Не считать ошибочно, что доступность Bundle означает
  запуск его Workflow Engine.

## Правило совместимости навыков

Выполнение всегда подчиняется явно согласованным пользовательским
требованиям и безопасности, затем полномочиям DevOS, затем обязательным
original Spec Kit stage instructions, затем **совместимым** адаптациям
Superpowers и необязательным skills. Нет silent overrides обязательных
правил. Список конфликтов валидируется до запуска: динамические
subagents, чужой planner/executor, auto-worktrees/merge, дублирующий
implementation plan, повторные approvals внутри утверждённого scope.

Upstream `github/spec-kit` остаётся неизменённым; исходный
`obra/superpowers` хранится отдельно от `devos-*` адаптаций.
Пин каждого skill/source содержит commit, SHA-256 и зависимые файлы.
Промежуточные обновления требуют diff + повторной проверки.

## Staging и Production

Новая версия сначала исполняется в отдельном локальном checkout
`DevOS-staging`, **полном физическом клоне** рабочего проекта с копиями
`.env`, `.devos`, авторизаций, сессий, профиля Camoufox и пользовательского
`~/.devos-staging`. Скопированные файлы не должны одновременно
записываться обеими системами. Обе системы сохраняют полный доступ к
Mac и общему GitHub, но у них собственные runtime paths, PID, сокеты,
MCP-порты и plugin connection.

Production оставляем на ngrok. Staging использует отдельный Cloudflare
Tunnel: текущий Quick Tunnel меняет адрес при restart, не поддерживает
SSE, поэтому только staging переключается на JSON-only MCP responses.
Скопированное OAuth-состояние сохраняется, но токен, привязанный к
публичному ngrok issuer/resource, нельзя считать действующим для нового
Cloudflare issuer. Тесты должны это выявлять, а не стирать state или
обходить проверку личности. Не публиковать credentials или chat URLs.

Во время **этой миграции** Main Agent реализует и проверяет задачи
самостоятельно, без запуска DevOS Runner и browser-worker graph по
решению владельца. После выпуска Runner остаётся штатным линейным
исполнителем независимых Issues. Production не останавливать и не
обновлять, пока staging не пройдёт интеграционные испытания и release
gate [#154](https://github.com/EmporioBreak/DevOS/issues/154).

## Текущее состояние кода — аудит исходного baseline

| Реальное место в репозитории | Имеющиеся возможности | Следующий контракт |
| --- | --- | --- |
| `src/workflow.ts`, `src/workflow-loader.ts` | Статический workflow для одной Issue, канонические statuses/worker routing | #144: pinned skill/stage manifest, preflight |
| `src/orchestrator.ts`, `src/json-state-store.ts` | Состояние задачи, continuation/rework/owner handoff | #144, #147: stage-aware continuation |
| `src/cli.ts`, `src/ready-tasks.ts` | CLI проекта и выбор задач GitHub | #143: управление Epic/Issue остаётся за Main Agent |
| `src/chatgpt-browser-executor.ts`, `src/shared-browser-runtime.ts` | Task-scoped browser tabs/session recovery | #146: regression/skills delivery |
| `src/codex-executor.ts` | Local Codex with saved sessions | #140, #146: native skill assignment/recovery |
| `src/connector.ts`, `src/connector-gateway.ts` | ngrok/Cloudflare transport, OAuth/MCP gateway | #123, #145: staging/plugin/auth compatibility |
| `src/chat-access.ts`, `src/chat-worker-grants.ts`, `src/chat-access-widget.ts` | Default-deny/on-demand chat auth и worker-grant machinery | #145: preserve + verify on real clients |
| `src/mcp-tools/`, `src/desktop-commander-integration.ts` | First-party DevOS tools и локальный Desktop Commander | #139: browser skill manifest/read/resources |
| Не обнаружено в baseline | Полный Spec Kit SDD/Bugfix/Assess, Skills Library, Superpowers adapters | #124–#142: новые подсистемы |

### Риски и доказательства

1. Смена OAuth resource при Staging Cloudflare не должна приводить к
   автоматическому общему bypass доступа других чатов.
2. Поддерживать lazy authorization без повторных iOS MCP Apps form cards.
3. Спорный статус browser POST не допускает replay опасного turn.
4. Отдельный браузерный worker не открывается вне нужного ChatGPT Project.
5. Codex fallback только после фактического `needs_local_worker`, а
   зависший process после логического terminal JSONL не блокирует граф.
6. Test-/Staging GitHub Issues/PR разрешены, но не push/merge в Production
   без release gate, с сохранением полного PR/diff/test trail.
7. Реальные интеграционные feature/bugfix/assess, browser/Codex,
   OAuth/Web/iPhone обязательны до признания миграции завершённой.

При любой неразрешённой зависимости состояние **blocked**, а не фиктивное
`approved`. Входящие детали: Epic #121 и дочерние Issues #122–154.
