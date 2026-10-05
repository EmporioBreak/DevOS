# DevOS

DevOS is a deliberately dumb local orchestrator for autonomous product development.

It replaces the manual work of opening one AI agent after another, passing work between them, waiting for completion, and routing review feedback back to implementation.

## Responsibilities

DevOS does:

- run a worker chosen by the main agent;
- wait for it to finish;
- parse one small machine-readable result;
- persist orchestration state;
- route to the next configured worker;
- resume after restart.

DevOS does **not** decide:

- what product to build;
- which roles are needed;
- whether code is good;
- how to implement a task;
- whether a review finding is correct;
- whether a result is production-ready.

Those decisions belong to AI agents.

## Shared memory

GitHub is the durable collaboration surface:

- issues describe tasks;
- pull requests contain the implementation;
- commits contain code history;
- comments contain worker reports;
- reviews contain findings and approvals.

Workers read the relevant GitHub task/PR themselves. DevOS should not accumulate or replay project history into prompts.

## Executors

A workflow may use different ways to run workers.

- `codex`: local Codex CLI for workers that need files, terminal, tools, simulators, SDKs, or other local capabilities.
- `chatgpt_browser`: normal ChatGPT through a persistent Playwright browser session for reasoning/review workers that do not need local filesystem access.

The main agent chooses the worker and executor. DevOS only executes that choice.

## Worker result

The meaningful report belongs in GitHub. The final line of a worker response is only orchestration control data:

```text
DEVOS_RESULT {"status":"done"}
```

Other statuses are `approved`, `changes_requested`, and `failed`. A worker may optionally return a configured worker id in `next`.

## Design rule

> DevOS owns coordination, never judgment.

See issue #1 for the MVP.
