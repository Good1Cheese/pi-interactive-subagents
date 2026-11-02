import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

for (const scenario of [
  { name: "leaf scout without spawning tools exits", count: undefined, spawning: false, exits: true },
  { name: "missing spawning telemetry stays unknown", count: undefined, spawning: true, exits: false },
  { name: "malformed telemetry stays unknown", count: () => -1, spawning: true, exits: false },
  { name: "live descendants retain the child", count: () => 1, spawning: true, exits: false },
  { name: "a pending question keeps the child resumable", count: () => 0, spawning: true, question: true, exits: false },
  { name: "an aborted child remains resumable", count: () => 0, spawning: true, aborted: true, exits: false },
  { name: "an interactive child remains resumable", count: () => 0, spawning: true, interactive: true, exits: false },
]) {
  test(scenario.name, async () => {
    const directory = mkdtempSync(join(tmpdir(), "native-child-leaf-"));
    const keys = ["PI_SUBAGENT_ID", "PI_SUBAGENT_LIFECYCLE_FILE", "PI_SUBAGENT_AUTO_EXIT", "PI_SUBAGENT_SESSION", "PI_AUTONOMY_CHILD_ROOT_RUN_ID"];
    const savedEnv = new Map(keys.map(key => [key, process.env[key]]));
    const countKey = Symbol.for("pi-subagents/running-children-count");
    const savedCount = (globalThis as any)[countKey];
    const lifecycleFile = join(directory, "lifecycle.json");
    Object.assign(process.env, {
      PI_SUBAGENT_ID: "leaf-child",
      PI_SUBAGENT_LIFECYCLE_FILE: lifecycleFile,
      PI_SUBAGENT_AUTO_EXIT: scenario.interactive ? "0" : "1",
      PI_SUBAGENT_SESSION: join(directory, "session.jsonl"),
      PI_AUTONOMY_CHILD_ROOT_RUN_ID: "root-run",
    });
    if (scenario.count) (globalThis as any)[countKey] = scenario.count;
    else delete (globalThis as any)[countKey];
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const events = createEventBus();
    const settledEvents: unknown[] = [];
    events.on("pi-interactive-subagents:child-lifecycle", event => settledEvents.push(event));
    let shutdown = false;
    try {
      subagentDoneExtension({
        events,
        on(name: string, handler: Function) { handlers.set(name, handler); },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerShortcut() {},
        getAllTools() { return scenario.spawning ? [{ name: "subagent" }] : [{ name: "read" }]; },
      } as any);
      handlers.get("agent_start")!();
      if (scenario.question) await tools.get("ask_question").execute("question", { question: "Need a decision" });
      handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: scenario.aborted ? "aborted" : "stop" }] });
      handlers.get("agent_settled")!({ aborted: scenario.aborted ?? false }, { shutdown() { shutdown = true; } });
      assert.equal(shutdown, scenario.exits);
      assert.equal(JSON.parse(readFileSync(lifecycleFile, "utf8")).state, scenario.exits ? "settled" : "running");
      assert.equal(settledEvents.length, scenario.exits ? 1 : 0, "only a terminal child publishes settlement");
      if (scenario.question || scenario.aborted) {
        handlers.get("input")!();
        handlers.get("agent_start")!();
        handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] });
        handlers.get("agent_settled")!({ aborted: false }, { shutdown() { shutdown = true; } });
        assert.equal(shutdown, true, "the answered/retried child can finish normally");
        assert.equal(JSON.parse(readFileSync(lifecycleFile, "utf8")).state, "settled");
      }
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      if (savedCount === undefined) delete (globalThis as any)[countKey]; else (globalThis as any)[countKey] = savedCount;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
