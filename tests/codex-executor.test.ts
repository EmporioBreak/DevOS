import assert from "node:assert/strict";
import test from "node:test";
import { LocalCommandRunner, type CommandResult, type CommandRunner } from "../src/command-runner.js";
import {
  CodexExecutor,
  CodexResumeUnavailableError,
  buildCodexArgs,
  buildCodexResumeArgs,
  parseFinalAgentMessage,
  parseThreadId,
} from "../src/codex-executor.js";

test("builds start and resume arguments explicitly", () => {
  const options = {
    model: "gpt-5.6-codex",
    reasoningEffort: "medium" as const,
    sandbox: "workspace-write" as const,
  };

  assert.deepEqual(
    buildCodexArgs("/project", "Do the work", options),
    [
      "exec", "-C", "/project",
      "--sandbox", "workspace-write",
      "-m", "gpt-5.6-codex",
      "-c", 'model_reasoning_effort="medium"',
      "--json",
    ],
  );

  assert.deepEqual(
    buildCodexResumeArgs("/project", "thread-1", "Continue", options),
    [
      "exec", "-C", "/project",
      "--sandbox", "workspace-write",
      "resume", "thread-1",
      "-m", "gpt-5.6-codex",
      "-c", 'model_reasoning_effort="medium"',
      "--json",
    ],
  );
});

test("parses thread id and final agent message", () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final\\nDEVOS_RESULT {\\\"status\\\":\\\"done\\\"}"}}',
  ].join("\n");

  assert.equal(parseThreadId(stdout), "abc-123");
  assert.equal(parseFinalAgentMessage(stdout), 'final\nDEVOS_RESULT {"status":"done"}');
});

test("resumes the supplied Codex session", async () => {
  const calls: Array<{ args: string[]; cwd: string; stdin: string | undefined }> = [];
  const runner: CommandRunner = {
    async run(_command, args, cwd, stdin): Promise<CommandResult> {
      calls.push({ args, cwd, stdin });
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          '{"type":"thread.started","thread_id":"session-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"DEVOS_RESULT {\\\"status\\\":\\\"done\\\"}"}}',
        ].join("\n"),
      };
    },
  };

  const result = await new CodexExecutor(runner).run({
    projectRoot: "/project",
    prompt: "Continue",
    sessionId: "session-1",
  });

  assert.equal(calls[0]?.args.includes("resume"), true);
  assert.equal(calls[0]?.cwd, "/project");
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["exec", "-C", "/project"]);
  assert.equal(calls[0]?.stdin, "Continue");
  assert.equal(calls[0]?.args.includes("Continue"), false);
  assert.equal(result.sessionId, "session-1");
});


test("classifies only a pre-execution missing resumed thread as safe to restart", async () => {
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "thread not found: session-1",
      };
    },
  };

  await assert.rejects(
    () => new CodexExecutor(runner).run({
      projectRoot: "/project",
      prompt: "Continue",
      sessionId: "session-1",
    }),
    error =>
      error instanceof CodexResumeUnavailableError &&
      error.sessionId === "session-1",
  );
});

test("does not classify a post-execution resume failure as safe to restart", async () => {
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
      return {
        exitCode: 1,
        stderr: "thread not found after execution",
        stdout: [
          '{"type":"thread.started","thread_id":"session-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"work may already have happened"}}',
        ].join("\n"),
      };
    },
  };

  await assert.rejects(
    () => new CodexExecutor(runner).run({
      projectRoot: "/project",
      prompt: "Continue",
      sessionId: "session-1",
    }),
    error =>
      error instanceof Error &&
      !(error instanceof CodexResumeUnavailableError) &&
      /Codex exited with code 1/.test(error.message),
  );
});


test("feeds fresh Codex prompt through stdin instead of argv", async () => {
  const calls: Array<{ args: string[]; stdin: string | undefined }> = [];
  const runner: CommandRunner = {
    async run(_command, args, _cwd, stdin): Promise<CommandResult> {
      calls.push({ args, stdin });
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          '{"type":"thread.started","thread_id":"session-2"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"DEVOS_RESULT {\\"status\\":\\"done\\"}"}}',
        ].join("\n"),
      };
    },
  };

  await new CodexExecutor(runner).run({
    projectRoot: "/project",
    prompt: "Do the work",
  });

  assert.equal(calls[0]?.stdin, "Do the work");
  assert.equal(calls[0]?.args.includes("Do the work"), false);
  assert.equal(calls[0]?.args.at(-1), "--json");
});

test("finishes a Codex JSONL worker turn while its child remains alive", async () => {
  for (const sessionId of [undefined, "resumed-1"]) {
    const threadId = sessionId ?? "fresh-1";
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: 'DEVOS_RESULT {"status":"done"}' },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n") + "\n";
    const childScript = [
      `require("node:child_process").spawn(${JSON.stringify(process.execPath)}, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });`,
      `process.stdout.write(${JSON.stringify(jsonl)});`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const runner: CommandRunner = {
      run(_command, _args, cwd, stdin, options) {
        return new LocalCommandRunner().run(
          process.execPath,
          ["-e", childScript],
          cwd,
          stdin,
          options,
        );
      },
    };
    const startedAt = Date.now();

    const result = await new CodexExecutor(runner).run({
      projectRoot: process.cwd(),
      prompt: "Complete this worker turn",
      ...(sessionId ? { sessionId } : {}),
    });

    assert.ok(Date.now() - startedAt < 1_000, "Codex completion should not wait for child exit");
    assert.equal(result.sessionId, threadId);
    assert.equal(result.text, 'DEVOS_RESULT {"status":"done"}');
  }
});

test("waits for turn.completed after the terminal agent message", async () => {
  const beforeTurnCompleted = [
    JSON.stringify({ type: "thread.started", thread_id: "turn-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: 'DEVOS_RESULT {"status":"done"}' },
    }),
  ].join("\n") + "\n";
  const completed = `${JSON.stringify({ type: "turn.completed", usage: {} })}\n`;
  const childScript = [
    `process.stdout.write(${JSON.stringify(beforeTurnCompleted)});`,
    `setTimeout(() => process.stdout.write(${JSON.stringify(completed)}), 150);`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const runner: CommandRunner = {
    run(_command, _args, cwd, stdin, options) {
      return new LocalCommandRunner().run(process.execPath, ["-e", childScript], cwd, stdin, options);
    },
  };
  const startedAt = Date.now();

  const result = await new CodexExecutor(runner).run({ projectRoot: process.cwd(), prompt: "Continue" });

  assert.ok(Date.now() - startedAt >= 100, "must remain alive until turn.completed arrives");
  assert.equal(result.sessionId, "turn-1");
});

test("does not accept turn.failed or error events as successful completion", async () => {
  for (const failedEvent of [
    { type: "turn.failed", error: { message: "turn failed" } },
    { type: "error", message: "stream failed" },
  ]) {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "failed-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: 'DEVOS_RESULT {"status":"done"}' },
      }),
      JSON.stringify(failedEvent),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n") + "\n";
    const runner: CommandRunner = {
      run(_command, _args, cwd, stdin, options) {
        return new LocalCommandRunner().run(
          process.execPath,
          ["-e", `process.stdout.write(${JSON.stringify(jsonl)}); setTimeout(() => process.exit(1), 100)`],
          cwd,
          stdin,
          options,
        );
      },
    };

    await assert.rejects(
      () => new CodexExecutor(runner).run({ projectRoot: process.cwd(), prompt: "Continue" }),
      /Codex exited with code 1/,
    );
  }
});

test("does not complete early for a malformed worker result", async () => {
  const jsonl = [
    JSON.stringify({ type: "thread.started", thread_id: "fresh-2" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "DEVOS_RESULT {broken" },
    }),
  ].join("\n") + "\n";
  const runner: CommandRunner = {
    run(_command, _args, cwd, stdin, options) {
      return new LocalCommandRunner().run(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(jsonl)}); setTimeout(() => process.exit(1), 100)`],
        cwd,
        stdin,
        options,
      );
    },
  };

  await assert.rejects(
    () => new CodexExecutor(runner).run({ projectRoot: process.cwd(), prompt: "Continue" }),
    /Codex exited with code 1/,
  );
});

test("does not complete early for an unterminated JSONL record", async () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "partial-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: 'DEVOS_RESULT {"status":"done"}' },
    }),
  ].join("\n");
  const runner: CommandRunner = {
    run(_command, _args, cwd, stdin, options) {
      return new LocalCommandRunner().run(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(stdout)}); setTimeout(() => process.exit(1), 100)`],
        cwd,
        stdin,
        options,
      );
    },
  };

  await assert.rejects(
    () => new CodexExecutor(runner).run({ projectRoot: process.cwd(), prompt: "Continue" }),
    /Codex exited with code 1/,
  );
});
