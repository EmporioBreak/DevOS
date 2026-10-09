# DevOS 2 — руководство по разработке и эксплуатации

Это **Staging-руководство к Epic #121**, а не заявление о состоявшемся выпуске. Новая архитектура пока собрана в цепочке изолированных draft PR. Автоматические проверки прошли, однако реальные ChatGPT Web/iPhone E2E, исходные оригинальные worker skill calls и перенос в Production ещё не приняты.

## 1. Принцип и состав системы

**DevOS** объединяет DevOS Main Agent, оригинальный GitHub Spec Kit, методы Superpowers, DevOS Skills Library, существующий DevOS Runner, DevOS MCP и GitHub. **Runner — только исполнитель заранее согласованной одной GitHub Issue**; он не заменяет Main Agent и не содержит второго Spec Kit workflow engine.

В нормальном проекте пользователь сначала обсуждает с Main Agent результат, альтернативы, границы и критерии. Архитектурные решения и существенные изменения scope обсуждаются **до** выполнения, без серии повторных согласований внутри утверждённой задачи. Main Agent получает подлинное подтверждение пользователя и привязывает его к точной версии оригинальных Spec Kit артефактов и полного worker graph; одна лишь строка `userMessageRef` в JSON не является доказательством.

Для текущей миграции действует особое правило: Main Agent разрабатывает Epic #121 **напрямую в изолированных Git worktrees и через draft PR**, не поручая построение DevOS 2 самому Runner. Production остаётся на старом подключении до release gate.

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

Примеры действующих CLI интерфейсов **для чтения** (из корня локального staging checkout):

```sh
./devos-staging skills status
./devos-staging skills issue EmporioBreak/DevOS 144 developer developer execution implement superpowers-test-driven-development
```

Первый показывает registry и SHA, второй — диагностический effective/frozen profile конкретной Issue. Для предварительного сравнения зарегистрированного навыка с локальным candidate JSON:

```sh
./devos-staging skills preview superpowers-test-driven-development path/to/candidate.json
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

## 6. Runner, Staging, повторы и диагностика

Только когда Main Agent уже зафиксировал полный graph и получил настоящие approvals, existing Runner можно вызывать из project-local checkout:

```sh
./devos run .devos/workflow.json
```

Обычный `run` возобновляет текущую Issue. `restart` — **намеренное** перепланирование и сброс state только этой Issue; не используйте его как автоматический retry неопределённого browser-turn. В DevOS 2 `skillsMode: "strict"` указывает на обязательный owner-signed graph/worker manifests; старые workflow без этого поля продолжают работать без breaking API.

Имена машинных статусов worker: `done`, `approved`, `changes_requested`, `needs_local_worker`, `failed`. Финальная задача возвращает `final_review_required`; это ещё не `completed`. Browser may-have-submitted **никогда** не отправляется повторно лишь потому, что SSE или MCP отчёт оборвались. Точный URL ранее созданного Project-чата сохраняется, нельзя заменять его новым разговором «на глазок».

**Staging и Production различаются**: независимый Staging checkout, Mac MCP/Cloudflare на :8788 и copied Camoufox profile; рабочий Production ngrok/MCP на :8787. Нет права сбрасывать production OAuth или restart в рамках QA. Cloudflare Quick Tunnel имеет временный hostname и JSON-only MCP response, поэтому его доступность не доказывает работающий ChatGPT Web/iPhone plugin.

Проверенные read-only/локальные команды без отправки ChatGPT turn:

```sh
npm run build
npx tsx --test tests/acceptance-matrix.test.ts
npm test
node scripts/staging-isolation-smoke.mjs
npx tsx scripts/staging-public-mcp.smoke.ts
npx tsx scripts/staging-safe-chaos.smoke.ts
```

На Staging было **520/520 PASS** в полном автоматическом прогоне (#149) и **73/73 PASS** в отдельном безопасном stress (#152). Настоящий Camoufox открыл ChatGPT Project и показал composer, но первый отправляемый QA-turn #150 завершился по deadline после потенциальной отправки. Локальный one-shot marker запрещает опасный повтор. **Не запускайте тестовый prompt повторно** просто ради зелёного отчёта; точная проверка возможна лишь при доказанной идентичности того же хода. ChatGPT iPhone plugin/authorization App ещё не принят (#151).

## 7. FAQ и восстановление

**Нужно ли давать пароль на каждый новый чат?** Нет. MCP default-deny разрешает данные Mac лишь после on-demand авторизации *конкретного* чата. У одобренного разговора повторные обычные вызовы не должны открывать ещё одну App-форму. Сведения о чужом чате с тем же OAuth токеном не должны становиться доступны. Если inline App не рендерится на iPhone, используйте Safari fallback URL, выданный **самим инструментом авторизации** для текущего чата; никогда не публикуйте пароль или ticket в GitHub.

**Почему браузерный Codex не запустился при сложной задаче?** Сложность не основание для fallback. Нужен настоящий browser attempt, конкретный host blocker, статус `needs_local_worker` и заранее записанный Codex worker; если граф не содержит этого пути, Runner fail-closed.

**Можно ли взять upstream Superpowers как есть?** Если он требует собственные subagents, Git branching, автоматический merge, rival review orchestration или отдельный план — нет. Сохраняйте immutable upstream и назначайте проверенный `devos-*` вариант с отдельной атрибуцией/commit pin.

**Почему зелёные тесты не означают релиз?** Автоматические fixture callbacks не доказывают настоящую пользовательскую авторизацию, ChatGPT Mobile App или GitHub review. Матрица `config/devos-v2-acceptance-matrix.json` различает автоматическое покрытие и живые обязательства #150–154. Пока последние не закрыты, Staging не продвигается в Production.

**Как откатывать?** Сначала отдельно подтверждённый release gate #154: зафиксировать production SHA, снять приватную резервную копию конфигураций, OAuth/session данных и рабочего профиля браузера, проверить инструкции и точку восстановления; содержимое backup и секреты **не отправлять в GitHub**. Выпускать только проверенные исходники/конфиги, **не копировать** Staging OAuth/session state на Production. При ошибке остановить принадлежащие именно релизу процессы, восстановить прежнюю проверенную версию и приватное состояние, проверить старый ChatGPT plugin Web/iPhone; не делать `git reset --hard` по умолчанию и не удалять пользовательские данные. Подробная проверка rollback должна быть выполнена и записана в #154 **до** первого Production релиза.

Дальнейшие технические контракты: [Runner и Skills](runner-skill-integration.md), [политика выбора](skill-policy.md), [оригинальный Spec Kit](spec-kit-predevelopment.md), [Bugfix](spec-kit-bugfix.md), [Assess](spec-kit-assessment.md), [матрица приёмки](devos-v2-verification-matrix.md), [реальный Staging blocker](live-staging-e2e-readiness.md), [безопасная диагностика browser-worker grant](worker-authorization-live-runbook.md), [MCP Web/iOS ограничения](staging-plugin-transport-readiness.md).
