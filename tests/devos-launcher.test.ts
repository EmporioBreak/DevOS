import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(repoRoot, "devos");

async function executable(file: string, body: string) {
  await writeFile(file, `#!/bin/sh
set -eu
${body}
`);
  await chmod(file, 0o755);
}

async function fixture(options: { selfHost?: boolean; runtimeHead?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "devos-launcher-"));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const log = path.join(root, "commands.log");
  await mkdir(bin);
  await mkdir(project);
  await cp(launcher, path.join(project, "devos"));
  await chmod(path.join(project, "devos"), 0o755);

  if (options.selfHost) {
    await mkdir(path.join(project, "src"));
    await mkdir(path.join(project, "node_modules"));
  } else if (options.runtimeHead) {
    await mkdir(path.join(project, ".devos", "runtime", "dist", "src"), { recursive: true });
    await writeFile(path.join(project, ".devos", "runtime", "dist", "src", "cli.js"), "");
  }

  await executable(path.join(bin, "node"), 'echo "node:$*" >> "$DEVOS_TEST_LOG"');
  await executable(
    path.join(bin, "npm"),
    'echo "npm:$PWD:$*" >> "$DEVOS_TEST_LOG"; if [ "$1 $2" = "run build" ]; then mkdir -p dist/src; : > dist/src/cli.js; fi',
  );
  await executable(
    path.join(bin, "git"),
    `echo "git:$*" >> "$DEVOS_TEST_LOG"
if [ "$1" = "-C" ] && [ "$3 $4" = "rev-parse --show-toplevel" ]; then
  [ "$DEVOS_SELF_HOST" = "1" ] && printf '%s\\n' "$2"
elif [ "$1" = "-C" ] && [ "$3 $4 $5" = "remote get-url origin" ]; then
  printf '%s\\n' "https://github.com/EmporioBreak/DevOS.git"
elif [ "$1" = "-C" ] && [ "$3 $4 $5" = "symbolic-ref --quiet --short" ]; then
  [ "$DEVOS_SELF_BRANCH" != "detached" ] && printf '%s\\n' "$DEVOS_SELF_BRANCH"
elif [ "$1" = "-C" ] && [ "$3 $4" = "status --porcelain" ]; then
  [ "$DEVOS_SELF_DIRTY" = "1" ] && printf '%s\\n' " M README.md"
elif [ "$1" = "-C" ] && [ "$3 $4 $5 $6" = "rev-parse --abbrev-ref --symbolic-full-name @{u}" ]; then
  printf '%s\\n' "$DEVOS_SELF_UPSTREAM"
elif [ "$1" = "-C" ] && [ "$3 $4" = "rev-parse HEAD" ]; then
  if [ "$DEVOS_SELF_HOST" = "1" ]; then printf '%s\\n' "$DEVOS_SELF_LOCAL_HEAD"; else printf '%s\\n' "$DEVOS_RUNTIME_HEAD"; fi
elif [ "$1" = "-C" ] && [ "$3 $4" = "rev-parse origin/main" ]; then
  printf '%s\\n' "$DEVOS_SELF_REMOTE_HEAD"
elif [ "$1" = "-C" ] && [ "$3 $4 $5 $6" = "merge-base --is-ancestor HEAD origin/main" ]; then
  [ "$DEVOS_SELF_RELATION" = "behind" ]
elif [ "$1" = "-C" ] && [ "$3 $4 $5 $6" = "merge-base --is-ancestor origin/main HEAD" ]; then
  [ "$DEVOS_SELF_RELATION" = "ahead" ]
fi`,
  );
  await executable(
    path.join(bin, "gh"),
    `echo "gh:$*" >> "$DEVOS_TEST_LOG"
if [ "$1" = "api" ]; then
  printf '%s\\n' "$DEVOS_REMOTE_HEAD"
elif [ "$1 $2" = "repo clone" ]; then
  target="$4"
  mkdir -p "$target/dist/src" "$target/node_modules"
  : > "$target/dist/src/cli.js"
fi`,
  );

  return {
    root,
    project,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DEVOS_TEST_LOG: log,
      DEVOS_SELF_HOST: options.selfHost ? "1" : "0",
      DEVOS_RUNTIME_HEAD: options.runtimeHead ?? "",
      DEVOS_REMOTE_HEAD: "current-sha",
      DEVOS_SELF_BRANCH: "main",
      DEVOS_SELF_DIRTY: "0",
      DEVOS_SELF_UPSTREAM: "origin/main",
      DEVOS_SELF_LOCAL_HEAD: "current-sha",
      DEVOS_SELF_REMOTE_HEAD: "current-sha",
      DEVOS_SELF_RELATION: "current",
    },
  };
}

function run(project: string, env: NodeJS.ProcessEnv) {
  return spawnSync(path.join(project, "devos"), ["run", "46"], {
    cwd: project,
    env,
    encoding: "utf8",
  });
}

test("self-hosting builds and executes the current checkout without a nested runtime", async () => {
  const f = await fixture({ selfHost: true });
  const result = run(f.project, f.env);
  assert.equal(result.status, 0, result.stderr);

  const log = await readFile(f.log, "utf8");
  assert.match(log, /npm:.*project:run build/);
  assert.match(log, /node:.*project\/dist\/src\/cli\.js run 46/);
  assert.doesNotMatch(log, /gh:repo clone/);
});

test("self-hosting fast-forwards a clean main checkout that is behind origin/main", async () => {
  const f = await fixture({ selfHost: true });
  const result = run(f.project, { ...f.env, DEVOS_SELF_LOCAL_HEAD: "old-sha", DEVOS_SELF_RELATION: "behind" });
  assert.equal(result.status, 0, result.stderr);

  const log = await readFile(f.log, "utf8");
  assert.match(log, /git:-C .* fetch origin main/);
  assert.match(log, /git:-C .* merge --ff-only origin\/main/);
  assert.match(log, /npm:.*project:install --no-package-lock/);
  assert.match(log, /npm:.*project:run build/);
});

test("self-hosting refuses a dirty checkout without updating or building", async () => {
  const f = await fixture({ selfHost: true });
  const result = run(f.project, { ...f.env, DEVOS_SELF_DIRTY: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /will not update a dirty checkout/);

  const log = await readFile(f.log, "utf8");
  assert.doesNotMatch(log, /fetch origin main/);
  assert.doesNotMatch(log, /npm:/);
});

test("self-hosting refuses a non-main branch non-destructively", async () => {
  const f = await fixture({ selfHost: true });
  const result = run(f.project, { ...f.env, DEVOS_SELF_BRANCH: "feature/work" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires main; current branch is feature\/work/);

  const log = await readFile(f.log, "utf8");
  assert.doesNotMatch(log, /fetch origin main/);
  assert.doesNotMatch(log, /npm:/);
});

test("self-hosting refuses a diverged main checkout without moving it", async () => {
  const f = await fixture({ selfHost: true });
  const result = run(f.project, {
    ...f.env,
    DEVOS_SELF_LOCAL_HEAD: "local-sha",
    DEVOS_SELF_REMOTE_HEAD: "remote-sha",
    DEVOS_SELF_RELATION: "diverged",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /diverged from origin\/main/);

  const log = await readFile(f.log, "utf8");
  assert.doesNotMatch(log, /merge --ff-only/);
  assert.doesNotMatch(log, /npm:/);
});

test("a current project-local runtime is reused without reinstall or rebuild", async () => {
  const f = await fixture({ runtimeHead: "current-sha" });
  const result = run(f.project, f.env);
  assert.equal(result.status, 0, result.stderr);

  const log = await readFile(f.log, "utf8");
  assert.match(log, /gh:api repos\/EmporioBreak\/DevOS\/commits\/main --jq \.sha/);
  assert.doesNotMatch(log, /gh:repo clone/);
  assert.doesNotMatch(log, /npm:/);
  assert.match(log, /node:.*\.devos\/runtime\/dist\/src\/cli\.js run 46/);
});

test("a stale project-local runtime is refreshed without touching project state", async () => {
  const f = await fixture({ runtimeHead: "stale-sha" });
  const state = path.join(f.project, ".devos", "state", "46.json");
  await mkdir(path.dirname(state), { recursive: true });
  await writeFile(state, '{"status":"running"}');

  const result = run(f.project, f.env);
  assert.equal(result.status, 0, result.stderr);

  const log = await readFile(f.log, "utf8");
  assert.match(log, /gh:repo clone EmporioBreak\/DevOS/);
  assert.match(log, /npm:.*runtime\.tmp\.[0-9]+:install --no-package-lock/);
  assert.match(log, /npm:.*runtime\.tmp\.[0-9]+:run build/);
  assert.equal(await readFile(state, "utf8"), '{"status":"running"}');
});
