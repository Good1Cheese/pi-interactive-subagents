import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

test("native child writes run-started and positive agent_settled evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-native-lifecycle-"));
  const lifecycleFile = join(dir, "lifecycle.json");
  const previousId = process.env.PI_SUBAGENT_ID;
  const previousFile = process.env.PI_SUBAGENT_LIFECYCLE_FILE;
  const previousRootRun = process.env.PI_AUTONOMY_CHILD_ROOT_RUN_ID;
  const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
  const countKey = Symbol.for("pi-subagents/running-children-count");
  const previousCount = (globalThis as any)[countKey];
  (globalThis as any)[countKey] = () => 0;
  process.env.PI_SUBAGENT_ID = "child-1";
  process.env.PI_SUBAGENT_LIFECYCLE_FILE = lifecycleFile;
  process.env.PI_AUTONOMY_CHILD_ROOT_RUN_ID = "root-1";
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  const events = createEventBus();
  const lifecycleEvents: unknown[] = [];
  events.on("pi-interactive-subagents:child-lifecycle", (event) => lifecycleEvents.push(event));
  const handlers = new Map<string, Function>();
  try {
    subagentDoneExtension({
      events,
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool() {}, registerCommand() {}, registerShortcut() {},
      registerMessageRenderer() {}, sendMessage() {}, sendUserMessage() {}, getAllTools() { return []; },
    } as any);

    handlers.get("agent_start")!();
    assert.deepEqual(JSON.parse(readFileSync(lifecycleFile, "utf8")), {
      childId: "child-1", sequence: 1, state: "running",
    });
    handlers.get("agent_settled")!({ aborted: false }, { shutdown() {} });
    assert.deepEqual(JSON.parse(readFileSync(lifecycleFile, "utf8")), {
      childId: "child-1", sequence: 1, state: "settled",
    });
    assert.deepEqual(lifecycleEvents, [{ rootRunId: "root-1", childId: "child-1", state: "settled" }]);
  } finally {
    if (previousId === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = previousId;
    if (previousFile === undefined) delete process.env.PI_SUBAGENT_LIFECYCLE_FILE;
    else process.env.PI_SUBAGENT_LIFECYCLE_FILE = previousFile;
    if (previousRootRun === undefined) delete process.env.PI_AUTONOMY_CHILD_ROOT_RUN_ID;
    else process.env.PI_AUTONOMY_CHILD_ROOT_RUN_ID = previousRootRun;
    if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
    else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
    if (previousCount === undefined) delete (globalThis as any)[countKey];
    else (globalThis as any)[countKey] = previousCount;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent settlement stays non-settled while a descendant is still running", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-descendant-wait-"));
  const lifecycleFile = join(dir, "lifecycle.json");
  const previousId = process.env.PI_SUBAGENT_ID;
  const previousFile = process.env.PI_SUBAGENT_LIFECYCLE_FILE;
  const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
  const countKey = Symbol.for("pi-subagents/running-children-count");
  const previousCount = (globalThis as any)[countKey];
  process.env.PI_SUBAGENT_ID = "child-with-descendant";
  process.env.PI_SUBAGENT_LIFECYCLE_FILE = lifecycleFile;
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  (globalThis as any)[countKey] = () => 1;
  let shutdown = false;
  const handlers = new Map<string, Function>();
  try {
    subagentDoneExtension({
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool() {}, registerCommand() {}, registerShortcut() {},
      registerMessageRenderer() {}, sendMessage() {}, sendUserMessage() {}, getAllTools() { return []; },
    } as any);
    handlers.get("agent_start")!();
    handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] });
    handlers.get("agent_settled")!({ aborted: false }, { shutdown() { shutdown = true; } });
    assert.deepEqual(JSON.parse(readFileSync(lifecycleFile, "utf8")), {
      childId: "child-with-descendant", sequence: 1, state: "running",
    });
    assert.equal(shutdown, false);
  } finally {
    if (previousId === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = previousId;
    if (previousFile === undefined) delete process.env.PI_SUBAGENT_LIFECYCLE_FILE;
    else process.env.PI_SUBAGENT_LIFECYCLE_FILE = previousFile;
    if (previousAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
    else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
    if (previousCount === undefined) delete (globalThis as any)[countKey];
    else (globalThis as any)[countKey] = previousCount;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native child publishes root-group state over the public Pi event bus", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-root-state-"));
  const stateFile = join(dir, "root.json");
  const previous = process.env.PI_SUBAGENT_ROOT_STATE_FILE;
  process.env.PI_SUBAGENT_ROOT_STATE_FILE = stateFile;
  const events = createEventBus();
  const observed: unknown[] = [];
  events.on("pi-interactive-subagents:root-group-state", (event) => observed.push(event));
  const handlers = new Map<string, Function>();
  try {
    writeFileSync(stateFile, JSON.stringify({ runId: "root-run", state: "open" }), { mode: 0o600 });
    subagentDoneExtension({
      events,
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool() {}, registerCommand() {}, registerShortcut() {},
      registerMessageRenderer() {}, sendMessage() {}, sendUserMessage() {}, getAllTools() { return []; },
    } as any);
    handlers.get("input")!();
    writeFileSync(stateFile, JSON.stringify({ runId: "root-run", state: "closed" }));
    handlers.get("input")!();
    assert.deepEqual(observed, [
      { rootRunId: "root-run", state: "open" },
      { rootRunId: "root-run", state: "closed" },
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_ROOT_STATE_FILE;
    else process.env.PI_SUBAGENT_ROOT_STATE_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
