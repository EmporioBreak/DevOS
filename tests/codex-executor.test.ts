import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult, CommandRunner } from "../src/command-runner.js";
import {
  CodexExecutor,
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
      "--json", "Do the work",
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
      "--json", "Continue",
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
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: CommandRunner = {
    async run(_command, args): Promise<CommandResult> {
      calls.push(args);
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

  assert.equal(calls[0]?.args.includes("resume"), true);\n  assert.equal(calls[0]?.cwd, "/project");\n  assert.deepEqual(calls[0]?.args.slice(0, 3), ["exec", "-C", "/project"]);
  assert.equal(result.sessionId, "session-1");
});
