# DevOS

DevOS — это намеренно простой локальный оркестратор для автономной разработки продуктов.

Его задача — убрать ручную работу по переключению между AI-агентами: запускать нужного агента, ждать завершения, читать машинный статус результата и запускать следующего.

## Главный принцип

> DevOS управляет координацией, но никогда не принимает интеллектуальные решения.

Главный агент решает:

- что именно нужно сделать;
- какие роли нужны для задачи;
- какой агент должен выполнять каждую роль;
- когда работу нужно вернуть на доработку;
- когда результат готов к финальному ревью;
- когда нужно позвать пользователя.

DevOS только исполняет этот workflow.

## Автономный цикл одной пользовательской задачи

Обычная единица работы DevOS — исходная задача пользователя, а не отдельный PR, тест или worker.

Например, пользователь говорит главному агенту: «сделай главную страницу». Главный агент фиксирует задачу, заранее составляет полный worker graph и после подтверждения пользователя запускает DevOS именно для этой задачи.

Один запуск DevOS проводит внутренний worker-цикл и после terminal review возвращает финальную проверку владельцу исходной задачи:

```text
пользовательская задача
        ↓
developer
        ├─ needs_local_worker → local_developer
        └─ done → reviewer
                    ├─ changes_requested → developer
                    ├─ needs_local_worker → local_reviewer
                    └─ approved → owner final review
                                      ├─ changes_requested → developer
                                      └─ approved → готово
```

Баги и замечания внутри этого graph не создают новые пользовательские задачи. Workers исправляют их внутри того же task state; final acceptance не является отдельным worker-ом.

DevOS не является daemon-ом и ничего не опрашивает, пока пользователь не запустил конкретную задачу. Процесс существует только во время выполнения workflow и завершается после terminal approval или блокирующей ошибки.

Запуск конкретной задачи:

```bash
devos run .devos/workflow.json
```

Если главный агент явно перепланировал ту же задачу, используется:

```bash
devos restart .devos/workflow.json
```

Сам способ передать готовый workflow из главного ChatGPT на локальный Mac и стартовать этот one-shot процесс — отдельный транспортный слой. Он не должен превращать DevOS в постоянно работающий polling-сервис.

## DevOS как локальная программка проекта

DevOS не нужно устанавливать глобально на компьютер.

В корне проекта лежит один launcher:

```text
my-project/
├─ devos
├─ src/
├─ ...
└─ .devos/
```

После копирования launcher-а в проект:

```bash
./devos
```

Файл поставляется как executable. Если конкретный способ скачивания сбросил executable bit, достаточно один раз выполнить `chmod +x devos`.

В обычном проекте launcher локально разворачивает runtime в `.devos/runtime/`. При каждом явном запуске он сверяет revision этого runtime с текущим `main` DevOS: актуальный runtime переиспользуется без reinstall/rebuild, а устаревший заменяется перед запуском workflow. Обновляется только `.devos/runtime/`; `.devos/config.json` и `.devos/state/` остаются на месте. Проверка выполняется только по вызову `./devos` — никакого `npm -g`, daemon-а, watcher-а или фонового updater-а нет.

В самом checkout `EmporioBreak/DevOS` launcher работает иначе: он распознаёт self-hosting по Git root и `origin`, перед запуском сверяет локальный source checkout с `origin/main`, затем собирает checkout и запускает его `dist/src/cli.js` напрямую. Clean `main`, который только отстаёт от `origin/main`, обновляется через fast-forward; уже актуальный checkout не двигается. Dirty checkout, другая ветка, detached HEAD, локальный `main` ahead/diverged или неожиданный upstream останавливают запуск с объяснением — launcher не делает автоматических reset/rebase/stash и не выбрасывает локальную работу. Вложенная копия `.devos/runtime/` для self-hosting не создаётся и не используется. Эта проверка, как и refresh обычного project-local runtime, выполняется только при явном вызове `./devos`.

Repo проекта определяется из локального `git remote origin` и сохраняется в `.devos/config.json`.

Там же можно задать обычный для проекта ChatGPT Project URL:

```json
{
  "version": 1,
  "repo": "owner/product",
  "chatgptProjectUrl": "https://chatgpt.com/g/g-p-project/c/"
}
```

Для новых `chatgpt_browser` worker-ов этот project-local URL имеет приоритет над `DEVOS_CHATGPT_PROJECT_URL`. Переменная окружения остаётся fallback-ом. URL может быть ссылкой на Project `https://chatgpt.com/g/<project-id>/` или его new-chat route `/g/<project-id>/c/`. Browser worker перед отправкой проверяет, что страница не вышла из этого Project, а после создания разговора сохраняет только URL вида `/g/<тот-же-project-id>/c/<conversation-id>`. Standalone `/c/<id>` и разговор из другого Project считаются ошибкой, а не допустимым fallback.

Обычный запуск:

```bash
./devos
```

DevOS один раз получает из GitHub открытые Issues текущего пользователя, выбирает только Issues с готовым `DEVOS_TASK_V1` workflow и показывает меню:

```text
Ready DevOS tasks for owner/product:

1. #35 Build homepage
2. #36 Add profile settings

Select task: 1

Starting #35: Build homepage
...
Task #35, completed (4 worker runs).
```


Во время исполнения DevOS также печатает короткие lifecycle-строки, сформированные самим оркестратором. Они показывают worker ID, executor, результат worker-а и следующий переход без вывода prompt-ов, ответов агента или conversation URL:

```text
Task #41 — running (start)
[developer] chatgpt_browser — starting fresh conversation
[developer] chatgpt_browser — done
→ reviewer
[reviewer] chatgpt_browser — resuming existing session
[reviewer] chatgpt_browser — approved
Main agent handoff
Task #41 — final_review_required
DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED","task":{"repo":"owner/product","issue":41,"pr":57}}
```

Для нового browser-разговора видно `starting fresh conversation`; при повторном входе того же worker-а в task-scoped session — `resuming existing session`. Переходы `needs_local_worker → local_*` и `changes_requested → developer` печатаются тем же способом: сначала возвращённый статус worker-а, затем строка `→ next_worker`. Ошибка worker-а по-прежнему завершает процесс с ненулевым кодом; перед ошибкой в stdout уже виден его статус `failed`.

Строка `DEVOS_OWNER_HANDOFF ...` остаётся отдельным machine-readable результатом для `main_agent`; человекочитаемая строка лишь делает момент handoff заметным в терминале.

После завершения workflow процесс DevOS заканчивается. В фоне ничего не остаётся и GitHub больше не опрашивается.

### Готовая задача

Главный агент помечает подготовленную Issue блоком:

```text
<!-- DEVOS_TASK_V1 -->
```

Сразу после marker идёт JSON с полным заранее составленным workflow:

```json
{
  "version": 1,
  "mode": "run",
  "workflow": {
    "version": 1,
    "task": {
      "repo": "owner/product",
      "issue": 35
    },
    "start": "developer",
    "workers": [
      {
        "id": "developer",
        "executor": "chatgpt_browser",
        "prompt": "Implement the task described in this GitHub Issue.",
        "on": {
          "done": null
        }
      }
    ]
  }
}
```

DevOS проверяет, что repo и Issue внутри workflow совпадают с выбранной GitHub Issue.

### Запуск через local Codex

Local Codex не обязан показывать интерактивное меню. Если номер уже подготовленной задачи известен, он запускает тот же project-local DevOS напрямую:

```bash
./devos run 35
```

После явного replan:

```bash
./devos restart 35
```

Файловый режим остаётся доступен:

```bash
./devos run .devos/workflow.json
```

Во всех случаях используется один и тот же one-shot orchestrator: процесс существует только пока выполняется конкретная пользовательская задача.

## GitHub как общая память

Для каждой задачи используются две естественные сущности GitHub.

### Issue — что нужно сделать

Issue хранит:

- постановку задачи;
- требования;
- ожидаемый результат;
- продуктовые решения;
- обсуждение задачи;
- ссылки на связанные реализации.

Issue существует независимо от конкретной реализации и остаётся долговременной памятью задачи.

### Pull request — как задача реализована

PR появляется, когда начинается конкретная реализация. В нём находятся:

- diff;
- commits;
- отчёты разработчиков;
- результаты тестирования;
- review-комментарии;
- замечания к конкретному коду;
- решение о merge.

Worker получает ссылку на Issue и, если он уже существует, связанный PR. Каждый worker сам читает нужный ему контекст через доступные GitHub-инструменты.

DevOS не должен собирать историю проекта в большой prompt, пересказывать работу предыдущих агентов или хранить параллельную «истину» в собственных evidence-файлах.

## Как проходит работа

Пример:

```text
главный агент
    ↓
Issue #42
    ↓
developer
    ↓
PR #57
    ↓
reviewer
    ├─ changes_requested → developer
    └─ approved → ui_tester
                         ↓
                   final_reviewer
```

Если reviewer просит изменения, DevOS снова запускает developer-а. Сам DevOS не анализирует замечания и не решает, правильны ли они.

После успешного merge связанная Issue может быть закрыта.

## Полный граф задаётся до запуска

Главный агент составляет весь worker graph до команды `devos run`.

Это означает:

- каждый worker, который потенциально может понадобиться, уже присутствует в `workers`;
- все переходы `on[status]` указывают только на заранее объявленных workers;
- fallback на local Codex тоже объявляется заранее, даже если эта ветка может ни разу не запуститься;
- во время исполнения worker не добавляет новые роли и не меняет маршрутизацию;
- DevOS не создаёт workers динамически.

Например, `needs_local_worker` не создаёт local Codex worker. Он только переводит управление на уже существующий worker из workflow.

Если во время работы обнаружилась действительно непредвиденная роль, исполнение нужно остановить. Главный агент формирует новый workflow, после чего запускает его через `devos restart <workflow.json>`. Эта команда очищает сохранённое состояние только текущей GitHub Issue и начинает новый graph с его `start` worker-а.

## Исполнители

Worker может запускаться разными способами.

### `chatgpt_browser`

Основной универсальный worker.

Это полноценный ChatGPT-агент, открытый DevOS через Playwright в постоянной браузерной сессии. Браузер по умолчанию видимый (headed): надёжность важнее скрытого окна, а headless на этом хосте наблюдался заблокированным Cloudflare. Для диагностики можно явно задать `DEVOS_BROWSER_HEADLESS=1 ./devos run <issue>`; для входа/отладки используйте `DEVOS_BROWSER_HEADLESS=0`. Допустимы только `0` и `1`; persistent profile сохраняет авторизацию после закрытия Chrome. Каждый worker turn переиспользует начальную страницу и закрывает весь принадлежащий ему context; зависшее закрытие ограничено по времени, принудительная очистка разрешена только для доказанно запущенного DevOS процесса. Неподтверждённая очистка сообщает ошибку, не завершает чужой Chrome. Ошибка headless не открывает видимое окно автоматически. Cloudflare challenge может блокировать ChatGPT даже с сохранённой авторизацией; headless launch сам по себе не доказывает успешный вход. В архитектуре DevOS считается, что он имеет тот же набор возможностей и инструментов, что и главный ChatGPT-агент.

`channel: chrome` уже использует современный Chrome Headless, а не headless shell ([Playwright](https://playwright.dev/docs/browsers#chromium-new-headless-mode)). `DEVOS_BROWSER_CHANNEL=chromium DEVOS_BROWSER_HEADLESS=1` выбирает bundled Chromium new headless; перед использованием существующего profile его версия должна быть совместима с Chrome, который уже открывал этот profile. Видимый режим не гарантирует доступ: если и он получает challenge/HTTP 403, нужен обычный ручной вход или разбор блокировки сервиса. Автоматического обхода, bootstrap или переключения режима нет.

Conversation URL worker-а хранится только в state текущей GitHub Issue, в `sessions[workerId]`. Поэтому повторный вход того же worker-а в рамках одной задачи открывает тот же conversation URL, а другая Issue начинает с пустого session map и создаёт новый разговор внутри настроенного ChatGPT Project. Для нового browser-разговора DevOS сохраняет validated Project conversation URL сразу после его появления, не дожидаясь завершения ответа агента, поэтому сбой response loading после создания чата не теряет identity разговора. До отправки prompt transient-сбои navigation/composer/context повторяются только на том же URL: максимум три попытки за 45 секунд. Недоступный сохранённый разговор, чужой Project, ошибки входа и challenge останавливают запуск с сохранением identity. Если первый запуск доказанно завершился до возможной отправки prompt и conversation URL ещё не существовал, task state сохраняет отдельное безопасное разрешение повторить тот же configured Project обычным следующим `run`; неизвестная или неоднозначная ошибка такого разрешения не даёт. Разрешение расходуется до следующей попытки и восстанавливается только при новом доказанном pre-submit сбое. После возможной отправки prompt автоматического повтора нет. DevOS захватывает ID user message из исходящего conversation POST. При сбое stream/page/context он до трёх минут открывает только тот же saved conversation и читает структурированный ответ conversation API через authenticated frontend: принимает только единственный завершённый assistant final, связанный с точным user message/turn и заканчивающийся валидным `DEVOS_RESULT`. Неизвестная identity, другой turn, недоступный/незавершённый ответ или неоднозначность останавливают выполнение с сохранением session и диагностикой. Response wait отделён от подготовки: активность stream продлевает ожидание до часового hard cap; пять минут без активности запускают read-only recovery. Закрытый или упавший context пересоздаётся с прежним persistent profile; URL разговора не заменяется. Перед первым запуском browser worker-а state также фиксирует, что этот worker уже стартовал. Если DevOS позже видит тот же task + worker без сохранённого conversation URL и без нового доказанного pre-submit разрешения (в том числе только со старым recovery marker-ом), он останавливается с явной ошибкой вместо молчаливого создания нового чата. Глобального worker-session registry нет.

Он может использовать доступные ему:

- GitHub-инструменты;
- web;
- файлы и проектный контекст;
- shell;
- sandbox-файловую систему;
- сборку и тесты;
- другие подключённые инструменты.

Поэтому сложность задачи сама по себе не является причиной использовать Codex.

### `codex`

Локальный Codex CLI — специальный worker для задач, которым нужен доступ именно к host machine и реальной локальной среде проекта.

Например:

- Xcode и iOS Simulator;
- Android Emulator;
- локальные SDK и системные зависимости;
- сервисы и процессы на машине пользователя;
- локальные устройства;
- окружение или файлы, недоступные ChatGPT-worker-у;
- другой host-specific runtime.

Главный агент выбирает executor по требуемой среде выполнения, а не по роли или сложности задачи.

Базовое правило:

- сначала запускать задачу через `chatgpt_browser`;
- worker должен реально попытаться выполнить её доступными инструментами;
- если он упёрся именно в недоступную ему host/local capability, он возвращает `needs_local_worker`;
- workflow механически переводит такую задачу на заранее настроенный `codex` worker.

Это позволяет экономить лимиты Codex и использовать локальный executor только после фактической невозможности выполнить задачу в ChatGPT-среде.

DevOS не определяет сам, нужен ли host. Он только следует статусу worker-а и переходам, которые заранее заданы главным агентом.

## Финальный handoff главному агенту

Workflow может явно передать финальную проверку главному агенту:

```json
{
  "owner": {
    "mode": "main_agent"
  }
}
```

В режиме `main_agent` DevOS не создаёт отдельного acceptance worker-а и не открывает отдельный ChatGPT conversation для владельца. Если workflow стартовал только с Issue, перед handoff DevOS ищет среди открытых PR единственную явную closing-ссылку, а при её отсутствии использует только единственное совпадение по тексту; несколько совпадений оставляют ссылку на Issue без PR. Закрытые старые PR не участвуют в поиске, чтобы случайное историческое упоминание не подменило текущую реализацию. Найденный PR сохраняется в task-local state. После worker-ов DevOS сохраняет state и завершает выполнение структурированной строкой:

```text
DEVOS_OWNER_HANDOFF {"status":"FINAL_REVIEW_REQUIRED","task":{"repo":"owner/product","issue":42,"pr":57}}
```

После финальной проверки главный агент может продолжить ту же задачу без потери worker conversations:

```bash
DEVOS_OWNER_RESULT=changes_requested ./devos run 42
```

или завершить её:

```bash
DEVOS_OWNER_RESULT=approved ./devos run 42
```

`approved` завершает задачу; `changes_requested` возвращает workflow к его заранее объявленному `start` worker-у и сохраняет task-scoped `sessions`. Это остаётся one-shot handoff: никакого callback daemon, watcher или polling service не появляется. Для уже сохранённого handoff старое внутреннее поле состояния читается и преобразуется при следующем сохранении.

Для новых workflow единственный допустимый owner mode — `main_agent`. Устаревшие `chatgpt_conversation` и `parent_process` конфигурации отклоняются с подсказкой использовать `main_agent`.

## Результат worker-а

Содержательный результат работы агент пишет в GitHub: в Issue, PR, review или комментарий — в зависимости от характера работы.

Каждый такой отчёт начинается с короткой подписи worker-а:

```text
**DevOS worker:** `reviewer` (`chatgpt_browser`)
```

Подпись содержит только worker ID и executor. Дополнительные run ID, timestamps или отдельная схема отчёта не нужны.

В собственном ответе worker оставляет только короткий управляющий результат для DevOS.

Последняя строка ответа должна иметь вид:

```text
DEVOS_RESULT {"status":"done"}
```

Поддерживаемые статусы:

- `done` — работа выполнена, переходить дальше по workflow;
- `approved` — review пройден;
- `changes_requested` — требуется вернуть работу указанному worker-у;
- `needs_local_worker` — worker попробовал выполнить задачу, но упёрся в возможность, доступную только на host/local environment;
- `failed` — выполнение остановлено из-за ошибки; state сохраняется для последующего resume или явного `restart`.

Worker не выбирает следующего исполнителя. Следующий шаг всегда определяется переходом `on[status]`, который заранее задал главный агент в workflow.

Статусы `needs_local_worker` и `changes_requested` требуют заранее объявленного перехода. Если такого перехода нет, DevOS сохраняет state и останавливается с ошибкой вместо того, чтобы считать workflow успешно завершённым.

`failed` никогда не маршрутизируется дальше: он всегда сохраняет state и останавливает workflow. Поэтому `on.failed` может быть только `null` или отсутствовать.

DevOS читает только этот управляющий статус. Смысл работы остаётся в GitHub.

## Что DevOS не должен делать

В ядре DevOS не должно быть requirements engine, technical planner, AI-выбора ролей, semantic quality gates, evidence subsystem, reconciliation engine, сложного policy routing или попыток определить, production-ready ли код.

Если для решения нужен интеллект — это задача агента, а не оркестратора.

## Правило разработки самого DevOS

После первоначального bootstrap все изменения DevOS делаются только через pull request.

Внутренний цикл разработки должен по возможности проходить локально. GitHub Actions не должен использоваться как постоянный внутренний цикл между каждым шагом агентов.

## Запуск

Минимальный запуск выполняется из корня проекта:

```bash
devos run .devos/workflow.json
```

Обычный `run` продолжает незавершённую задачу из сохранённого state. После явного replan для той же Issue используется:

```bash
devos restart .devos/workflow.json
```

`restart` сначала удаляет state этой задачи, а затем запускает новый graph с его `start` worker-а.

Файл workflow описывает только уже принятое главным агентом решение: какие workers нужны, каким executor-ом запускать каждого и куда переходить по управляющему статусу.

Пример:

```json
{
  "version": 1,
  "task": {
    "repo": "owner/product",
    "issue": 42,
    "pr": 57
  },
  "start": "developer",
  "workers": [
    {
      "id": "developer",
      "executor": "chatgpt_browser",
      "prompt": "Implement the task described in GitHub.",
      "on": {
        "done": "reviewer",
        "needs_local_worker": "local_developer"
      }
    },
    {
      "id": "local_developer",
      "executor": "codex",
      "prompt": "Continue the developer task using the host environment.",
      "on": {
        "done": "reviewer",
        "failed": null
      }
    },
    {
      "id": "reviewer",
      "executor": "chatgpt_browser",
      "prompt": "Review the implementation and report findings in GitHub.",
      "on": {
        "approved": null,
        "changes_requested": "developer",
        "needs_local_worker": "local_reviewer"
      }
    },
    {
      "id": "local_reviewer",
      "executor": "codex",
      "prompt": "Continue the review using the host environment.",
      "on": {
        "approved": null,
        "changes_requested": "developer",
        "failed": null
      }
    }
  ]
}
```

DevOS не выбирает роли или executor-ы из этого файла. Он только исполняет уже заданный workflow.

Незавершённое состояние хранится отдельно для каждой GitHub Issue в `.devos/state/`. Worker conversations являются частью этого task-local state и индексируются только по worker ID внутри конкретной Issue. После финального `approved` состояние этой задачи удаляется только после записи completion marker; при ошибке, main-agent handoff или `changes_requested` оно остаётся для продолжения.
Рабочая папка по умолчанию — каталог проектного `devos`, даже при вызове из другой папки. `.devos/runtime` содержит только исполняемый runtime. Инструкции локальному worker-у требуют работать в этой папке, не создавать другой clone/worktree и не переходить для работы в runtime/cache; разрешена task branch здесь. Это контракт для агента, а не файловая песочница.
Локальные `codex` worker-сессии привязаны к project root задачи. DevOS передаёт этот root одновременно как cwd процесса и через `codex exec -C` для fresh/resume запусков; сохранённая сессия с другим root не возобновляется. Если Codex до начала выполнения явно сообщает, что сохранённый thread/session недоступен для resume, DevOS сбрасывает только session id текущего worker и один раз продолжает fresh-сессией в правильном project root, сохраняя task state и сессии остальных workers. Ошибки после начала execution/output parsing не переигрывают worker prompt автоматически: исходная session сохраняется, чтобы не дублировать уже возможные side effects. `codex` worker уже является локальным и поэтому не может вернуть `needs_local_worker`; такая попытка завершается точной executor/status ошибкой. Browser worker по-прежнему может использовать `needs_local_worker`, если fallback объявлен workflow.

Для форензики одного запуска можно явно включить `DEVOS_DEBUG=1 ./devos run <issue>`. DevOS создаёт локальный append-only JSONL в `.devos/debug/<repo>-issue-<issue>.jsonl` и пишет туда CLI/project-root контекст, ordered orchestration lifecycle, browser fresh/resume/navigation/session URLs и локальные process start/end события с cwd, аргументами, stdout/stderr, exit code, termination signal и elapsed time. Поля credential-типа и очевидные auth/token значения редактируются; обычные prompts/output/path/repository context сохраняются. Режим выключен по умолчанию, ничего не отправляет наружу и не создаёт daemon/watcher/background collector.
После terminal approval DevOS записывает локальный marker в
`.devos/completed/<issue>`. Такие Issues скрыты из списка, а обычный
`./devos run <issue>` отказывается запускать их повторно. Для явного
перепланирования используйте `./devos restart <issue>` или
`./devos restart .devos/workflow.json`, в том числе для закрытой ready Issue. Если финализация прервана, обычный `run` завершает запись marker и очистку state без повторного запуска workers. Перед продолжением финального ревью
completion не записывается: `FINAL_REVIEW_REQUIRED` оставляет задачу ожидающей
решения владельца.
