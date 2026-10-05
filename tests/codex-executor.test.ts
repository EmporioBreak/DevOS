import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandRunner } from "../src/command-runner.js";
import {
  CodexExecutor,
  buildCodexArgs,
  parseFinalAgentMessage,
  parseThreadId,
} from "../src/codex-executor.js";

test("builds codex exec arguments without hidden routing decisions", () => {
  assert.deepEqual(
    buildCodexArgs("/project", "Do the work", {
      model: "gpt-5.6-codex",
      reasoningEffort: "medium",
      sandbox: "workspace-write",
    }),
    [
      "exec",
      "-C",
      "/project",
      "--sandbox",
      "workspace-write",
      "-m",
      "gpt-5.6-codex",
      "-c",
      'model_reasoning_effort="medium"',
      "--json",
      "Do the work",
    ],
  );
});

test("parses thread id and final agent message from codex json stream", () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"abc-123"}',
    'not-json diagnostic',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final\\nDEVOS_RESULT {\\\"status\\\":\\\"done\\\"}"}}',
  ].join("\n");

  assert.equal(parseThreadId(stdout), "abc-123");
  assert.equal(
    parseFinalAgentMessage(stdout),
    'final\nDEVOS_RESULT {"status":"done"}',
  );
});

test("executor returns final message and session id", async () => {
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
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
    prompt: "Implement",
  });

  assert.deepEqual(result, {
    text: 'DEVOS_RESULT {"status":"done"}',
    sessionId: "session-1",
  });
});

test("executor rejects non-zero codex exit", async () => {
  const runner: CommandRunner = {
    async run(): Promise<CommandResult> {
      return { exitCode: 2, stdout: "", stderr: "boom" };
    },
  };

  await assert.rejects(
    () => new CodexExecutor(runner).run({ projectRoot: "/project", prompt: "x" }),
    /Codex exited with code 2: boom/,
  );
});
