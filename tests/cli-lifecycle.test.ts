import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { markTaskCompleted, isTaskCompleted } from "../src/completed-tasks.js";
import { JsonStateStore } from "../src/json-state-store.js";

// Executable fixtures exercise the actual CLI/runner wiring, with no live workers.
test("closed completed Issue restart works; ordinary run and owner continuation stay guarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "devos-cli-lifecycle-"));
  const oldPath = process.env.PATH;
  const oldOwner = process.env.DEVOS_OWNER_RESULT;
  try {
    delete process.env.DEVOS_OWNER_RESULT;
    await mkdir(join(root, ".devos"));
    await writeFile(join(root, ".devos", "config.json"), JSON.stringify({ version: 1, repo: "owner/product" }));
    const workflow = { version: 1, task: { repo: "owner/product", issue: 59 }, start: "local", workers: [{ id: "local", executor: "codex", prompt: "Fixture", on: { done: null } }] };
    const body = `<!-- DEVOS_TASK_V1 -->\n\`\`\`json\n${JSON.stringify({ version: 1, mode: "run", workflow })}\n\`\`\``;
    const gh = join(root, "gh");
    const codex = join(root, "codex");
    await writeFile(gh, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify({ number: 59, title: "Fixture", state: "CLOSED", body }))});\n`);
    await writeFile(codex, `#!${process.execPath}\n${[
      { type: "thread.started", thread_id: "fixture-thread" },
      { type: "item.completed", item: { type: "agent_message", text: 'DEVOS_RESULT {"status":"done"}' } },
      { type: "turn.completed" },
    ].map(event => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("\n")}\n`);
    await chmod(gh, 0o755); await chmod(codex, 0o755);
    process.env.PATH = `${root}:${oldPath}`;
    await markTaskCompleted(root, 59);
    await assert.rejects(main(["run", "59"], root), /not an open ready/);
    process.env.DEVOS_OWNER_RESULT = "approved";
    await assert.rejects(main(["run", "59"], root), /already completed|waiting for final review/);
    delete process.env.DEVOS_OWNER_RESULT;
    await main(["restart", "59"], root);
    assert.equal(await isTaskCompleted(root, 59), true);
    const store = new JsonStateStore(root, workflow.task);
    assert.equal(await store.load(), null);
    // Interrupted bookkeeping resumes even for CLOSED Issues with a marker already present.
    await store.save({ currentWorkerId: "local", completedRuns: 1, sessions: { local: "saved" }, task: workflow.task, completionApproved: true });
    await rm(codex);
    await main(["run", "59"], root);
    assert.equal(await store.load(), null);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldOwner === undefined) delete process.env.DEVOS_OWNER_RESULT; else process.env.DEVOS_OWNER_RESULT = oldOwner;
    await rm(root, { recursive: true, force: true });
  }
});
