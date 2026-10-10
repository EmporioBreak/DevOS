# DevOS 2 — защищённое подтверждение плана задачи

Прежний `verifyOwner` был обязательным callback без реального Production-источника.
Текст ChatGPT «Утверждаю», запись ассистента в GitHub, OAuth или разрешённый
`devos_noop` **не являются** доказательством согласия на конкретный граф.

## Точная последовательность

1. Main Agent формирует и сверяет реальные Git SHA, Issue/PR, SHA-256 Constitution,
   scope/spec/plan digest, `projectGraphDigest` и `issueSkillsApprovalDigest`.
2. В ранее одобренном **owner**, не worker-чате вызывает
   `devos_owner_approval_request` с `repo`, `issue`, `pr`, `gitSha` (40 hex),
   `constitutionSha` (64 hex) и массивом `{kind,digest}` для constitution,
   scope/spec/plan, отдельно plan для worker graph и skills roster.
3. Ответ только выдаёт одноразовую пяти-минутную HTTPS-ссылку.
   Он **не** подписывает согласие и не запускает DevOS Runner.
4. Владелец открывает HTTPS-форму, сверяет задачу/PR/все SHA, вводит
   отдельный пароль DevOS непосредственно в форму и нажимает
   «Утверждаю точно указанные версии». Пароль никогда не попадает в чат.
5. `devos_owner_approval_status({ticket})` из той же одобренной сессии
   возвращает `approval_ref` только при настоящем человеческом подтверждении.
   Это ссылка на подписанный объект, не само доказательство.

## Доверенная проверка
Модуль `owner-task-approval.ts` предоставляет `trustedTaskApprovalVerifier`
для штатных `prepareApprovedRunnerSkills` и `prepareApprovedProjectPlan`.
В локальном trusted host/Main Agent создаётся `OwnerTaskApprovalStore` с
действительным owner secret и проверяется receipt из `.devos/owner-approvals/`.
Поле `OwnerApprovalEvidence.userMessageRef` получает фактический `approval_ref`;
проверяются HMAC, права 0600, точный repo/issue/pr/gitSha/constitutionSha и
каждый `kind/digest`. Поддельный текст или изменённый граф отвергаются.

Подтверждение Constitution отдельно проверяют вызовом `store.verify` с
`kind:"constitution"`, её фактическим SHA и точной привязкой задачи.
Обязательны оригинальные Spec Kit stage attestations и настоящие Git bytes.
Шаблон с плейсхолдерами не может считаться ратифицированным автоматически.

Чужой ChatGPT-чат, worker grant или отозванный owner-чат не могут запросить
подписание. Три неверные попытки исчерпывают одноразовый ticket. Новый
отличающийся план во время pending-подтверждения не подменяет исходный.
Данные и подписанные receipts не публикуются на GitHub.

## Граница E2E #214

Наличие этого кода или локальный synthetic happy-path тест **не означает**
реальный PASS задачи #214. Для запуска нужны реальное новое подтверждение
в защищённой форме, ratified Constitution, официальные Spec Kit stages,
подписанные manifests/graph, реальный browser developer, independent reviewer
и `FINAL_REVIEW_REQUIRED` handoff. Старое устное «Утверждаю» не переписывается
задним числом в якобы подписанный receipt. Native iPhone и Staging не тестируем.
