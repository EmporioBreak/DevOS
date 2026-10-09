# Официальный Spec Kit в DevOS 2 Staging

Поставщик: `github/spec-kit`, tag `v1.1.2`, peeled commit
`959e866caa3618bf3dc290d5dca33394365af9c6`.
SHA-256 всех оригинальных файлов и происхождение — в
`config/devos-upstreams.lock.json` (Issue #124).

## Проверенная установка

Из корня отдельного **staging worktree**:

```sh
node scripts/devos-upstreams.mjs verify --root "$HOME/.devos-staging/upstream"
uvx --from "$HOME/.devos-staging/upstream/spec-kit" specify init \
  --here --force --non-interactive --integration codex \
  --script sh --ignore-agent-tools
```

CLI берётся из исходного pinned source, не из изменённого форка или
непроверенной версии PyPI. `uvx` использует локальный cache Python,
не перезаписывает оригинальные vendor-файлы.

Результат оригинального CLI: `.specify/` с templates, bash scripts,
manifest и constitution starter; `.agents/skills/speckit-*/SKILL.md`
с десятью skills: constitution, specify, clarify, plan, checklist,
tasks, analyze, implement, converge, deprecated taskstoissues.
Создание веток и выполнение workflow engine не запускалось.
Git Extension не установлен автоматически; его подключение и
`auto_commit.default: false` — отдельная Issue #126.

Для многозадачной работы Spec Kit поддерживает окружение
`SPECIFY_INIT_DIR`, `SPECIFY_FEATURE_DIRECTORY` и
`SPECIFY_FEATURE_NO_PERSIST=1`: используем в последующей интеграции
per-Issue/worktree; не позволяем разным worker менять общий feature.json.

## Проверки

- `AGENTS.md` hash до/после `specify init` — совпал.
- Все 10 оригинальных skills существуют и содержат инструкции.
- `specify artifact list --json` — 19 обнаруженных артефактов.
- `npm run build` и `tsx --test tests/spec-kit-scaffold.test.ts` — PASS.
- `git checkout` / `git commit` в bash create-feature scaffold не найдены.
- `specify workflow run` не вызывался. Presets не включались.

Это только установка и smoke официальной методологии. Реальное
взаимодействие с Main Agent/Runner, Bugfix/Assess, Git Extension и
Skills Library реализуется отдельными Issues Epic #121.
