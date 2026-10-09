# Единый контракт Spec Kit артефактов и GitHub Issues

GitHub Epic #121 задаёт порядок независимых Issues; Main Agent
руководит зависимостями. Runner получает одну готовую Issue, не выбирает
соседние задачи и не становится продуктовым планировщиком.

## Канонические файлы

Одна feature имеет **ровно один** Spec Kit `spec.md`, `plan.md`,
`tasks.md` внутри `specs/<feature>/` или
`specs/<scope>/<feature>/`. Остальные research/design/checklists
располагаются там же. Superpowers `devos-writing-plans` обогащает
эти файлы, **не создаёт второй `docs/superpowers/plans/`**.

Оригинальные команды Spec Kit для других сценариев используют **другие**,
официальные пути:
- Bugfix: `.specify/bugs/<slug>/assessment.md`,
  `fix.md`, `test.md`.
- Assess: `.specify/assessments/<slug>/intake.md`,
  `research.md`, `problem.md`, `concept.md`, `decision.md`.

Эти имена и пути взяты из оригинальных pinned upstream инструкций
Spec Kit v1.1.2; дополнительный собственный Bugfix/Assess формат не вводим.

## GitHub Issue metadata

Issue содержит один машинно-валидируемый **reference-only** блок,
не дублирующий содержимое файлов. Пример:

````markdown
<!-- DEVOS_SPECKIT_V1 -->
```json
{
  "version": 1,
  "task": { "repo": "EmporioBreak/DevOS", "issue": 201 },
  "epic": 121,
  "scenario": "feature",
  "phase": "approved",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "artifactDirectory": "specs/issue-201/my-feature",
  "artifacts": {
    "spec": "specs/issue-201/my-feature/spec.md",
    "plan": "specs/issue-201/my-feature/plan.md",
    "tasks": "specs/issue-201/my-feature/tasks.md"
  },
  "dependsOn": [200]
}
```
<!-- /DEVOS_SPECKIT_V1 -->
````

Значение `commit` в примере **не является существующим
ревизионом**; при реальной публикации нужен полный 40-символьный SHA
коммита, в котором фактически находятся эти файлы.

Парсер `src/spec-kit-contract.ts` отклоняет лишние/дублирующие блоки,
неизвестную версию, неверную SHA, несовместимый тип сценария,
неверные пути, самозависимость, одинаковые зависимости и
циклический граф Issues. Актуальный `phase`: `draft`, `approved`,
`running`, `converging`, `accepted`; изменения этапа/ссылки
Main Agent публикует в том же Issue вместе с новой доказанной SHA.

`verifySpecKitArtifactPaths` проверяет, что файлы существуют в
назначенном worktree и ни один символический линк не указывает за его
пределы. `verifySpecKitArtifactRevision` дополнительно читает оригинал
каждого файла из указанного Git-коммита и сравнивает байты с checkout.
Если SHA отсутствует, content diverged или часть файлов не закоммичена,
система сообщает блокер, а не объявляет документ согласованным.

## Рабочий цикл

Main Agent фиксирует spec/plan/tasks в Git, записывает SHA и метаданные
в GitHub Issue и получает нужное одобрение пользователя **до** запуска
воркеров. После исправления/Converge ссылка и commit обновляются
явно (append-only изменение задач принадлежит Spec Kit).
GitHub PR связывается с Issue обычными существующими средствами,
а не через второй источник plan/tasks.

Issue #201 и зависимая #202 могут находиться в разных task worktrees,
при этом их feature paths и SHA различаются; тесты запрещают общий
путь за пределами worktree и циклы. `SPECIFY_FEATURE_NO_PERSIST=1`
предотвращает гонку общего `.specify/feature.json` в одном checkout.

**Scope текущей Issue #127:** формат, валидатор, безопасные ссылки.
Сам механизм создания/обновления GitHub Issues и управление жизненным
циклом Главного агента относятся к #143; Runner-интеграция — #144.
