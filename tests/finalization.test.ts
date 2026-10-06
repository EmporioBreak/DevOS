import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Orchestrator, type OrchestrationEvent } from "../src/orchestrator.js";
import { JsonStateStore } from "../src/json-state-store.js";
import { recordTaskCompletion, isTaskCompleted } from "../src/completed-tasks.js";
import type { Workflow } from "../src/workflow.js";

for (const failure of ["marker", "clear"] as const) {
  test(`approval survives ${failure} failure and retries bookkeeping without workers`, async () => {
    const root = await mkdtemp(join(tmpdir(), "devos-finalize-"));
    try {
      const workflow: Workflow = { version: 1, task: { repo: "owner/product", issue: 59 }, owner: { mode: "main_agent" }, start: "reviewer", workers: [{ id: "reviewer", executor: "codex", prompt: "Review", on: { approved: null } }] };
      const store = new JsonStateStore(root, workflow.task);
      await store.save({ currentWorkerId: "reviewer", completedRuns: 2, sessions: { reviewer: "saved" }, task: workflow.task, mainAgentReviewPending: true });
      if (failure === "marker") await writeFile(join(root, ".devos", "completed"), "blocker");
      const events: OrchestrationEvent[] = [];
      let clearFails = failure === "clear";
      const options = { projectRoot: root, workflow, executors: new Map(), stateStore: {
        load: () => store.load(), save: (state: Parameters<JsonStateStore["save"]>[0]) => store.save(state),
        clear: async () => { if (clearFails) throw new Error("clear interrupted"); await store.clear(); },
      }, finalizeTask: async (state: Parameters<typeof recordTaskCompletion>[2]) => { await recordTaskCompletion(root, 59, state); }, onEvent: (event: OrchestrationEvent) => { events.push(event); } };
      await assert.rejects(new Orchestrator({ ...options, mainAgentDecision: "approved" }).run());
      const saved = await store.load();
      assert.equal(saved?.completionApproved, true);
      assert.equal(saved?.sessions.reviewer, "saved");
      assert.equal(events.some(event => event.type === "task_status" && event.status === "completed"), false);
      if (failure === "marker") {
        assert.equal(await isTaskCompleted(root, 59).catch(() => false), false);
        await rm(join(root, ".devos", "completed"));
        await mkdir(join(root, ".devos", "completed"));
      }
      clearFails = false;
      await new Orchestrator(options).run();
      assert.equal(await isTaskCompleted(root, 59), true);
      assert.equal(await store.load(), null);
      assert.equal(events.filter(event => event.type === "task_status" && event.status === "completed").length, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
