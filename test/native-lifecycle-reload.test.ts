import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

async function harness(t: test.TestContext, sendMessage: (...args: any[]) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "subagent-native-reload-"));
  const oldEnv = { ...process.env };
  const oldCwd = process.cwd();
  t.after(() => {
    try { handlers.get("session_shutdown")?.({ reason: "quit" }, ctx); } catch {}
    process.chdir(oldCwd);
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.PI_SUBAGENT_ALLOWED;
  process.env.TMUX = "fake";
  process.env.TMUX_PANE = "%1";
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  const config = join(process.env.XDG_CONFIG_HOME, "pi-interactive-subagents");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.json"), JSON.stringify({ status: { enabled: true }, tmux: { mode: "panes", layout: "tiled", labels: "bottom" } }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const captureCount = join(root, "captures");
  writeFileSync(join(bin, "tmux"), `#!/bin/sh\nif [ "$1" = capture-pane ]; then n=$(cat '${captureCount}' 2>/dev/null || echo 0); echo $((n+1)) > '${captureCount}'; echo working; elif [ "$1" = split-window ]; then echo %123; fi\nexit 0\n`, { mode: 0o700 });
  process.env.PATH = `${bin}:${oldEnv.PATH}`;
  process.chdir(root);
  const events = createEventBus();
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const pi = {
    events,
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage,
  } as any;
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, '{"type":"session","id":"parent"}\n');
  const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent", getSessionDir: () => root } };
  const mod = await import(`../pi-extension/subagents/index.ts?test=${Date.now()}-${Math.random()}`);
  mod.default(pi);
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  events.on("pi-interactive-subagents:prepare-child", (raw) => {
    const request = raw as any;
    request.provided = true;
    request.rootRunId = "native-test-run";
    request.provider = "test-provider";
    request.model = "test-model";
    request.extensions = [fileURLToPath(new URL("../pi-extension/subagents/subagent-done.ts", import.meta.url))];
    request.env = { PI_AUTONOMY_CHILD_ROOT_RUN_ID: "native-test-run" };
  });
  return { root, captureCount, events, handlers, tools, ctx, pi, mod };
}

async function waitForCapture(path: string, after: number): Promise<number> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    let count = 0;
    try { count = Number(readFileSync(path, "utf8")); } catch {}
    if (count > after) return count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("watcher did not poll tmux before timeout");
}

function captureNumber(path: string): number {
  try { return Number(readFileSync(path, "utf8")); } catch { return 0; }
}

async function launch(h: Awaited<ReturnType<typeof harness>>, name: string) {
  return h.tools.get("subagent").execute("call", { agent: "worker", name, task: "test task" }, undefined, undefined, h.ctx);
}

test("public native launch records survive shutdown and extension reload snapshots", async (t) => {
  const h = await harness(t);
  const started = await launch(h, "reload-child");
  assert.equal(started.details.status, "started", JSON.stringify(started));
  const before: any = { rootRunId: "native-test-run" };
  h.events.emit("pi-interactive-subagents:children-snapshot", before);
  assert.deepEqual(before.children, [{ childId: started.details.id, state: "started" }]);

  h.handlers.get("session_shutdown")!({ reason: "reload" }, h.ctx);
  const reloaded = await import(`../pi-extension/subagents/index.ts?reloaded=${Date.now()}`);
  reloaded.default(h.pi);
  h.handlers.get("session_start")!({ reason: "reload" }, h.ctx);
  const after: any = { rootRunId: "native-test-run" };
  h.events.emit("pi-interactive-subagents:children-snapshot", after);
  assert.deepEqual(after.children, [{ childId: started.details.id, state: "started" }]);
  h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
});

test("public shutdown reports an aborted native child as unknown, never settled", async (t) => {
  const h = await harness(t);
  const observed: any[] = [];
  h.events.on("pi-interactive-subagents:child-lifecycle", (event) => observed.push(event));
  const started = await launch(h, "cancel-child");
  await waitForCapture(h.captureCount, 0);
  h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
  const until = Date.now() + 2000;
  while (Date.now() < until && !observed.some((event) => event.childId === started.details.id && event.state === "unknown"))
    await new Promise((resolve) => setTimeout(resolve, 10));
  const states = observed.filter((event) => event.childId === started.details.id).map((event) => event.state);
  assert.ok(states.includes("unknown"), `expected unknown lifecycle event, got ${states.join(", ")}`);
  assert.ok(!states.includes("settled"), `aborted child must not be settled: ${states.join(", ")}`);
});

test("public watcher retains malformed and undeliverable questions, then delivers and consumes them", async (t) => {
  let failDelivery = true;
  let delivered!: (message: any) => void;
  const deliveredMessage = new Promise<any>((resolve) => { delivered = resolve; });
  const sent: any[] = [];
  const h = await harness(t, (message: any) => {
    if (message.customType === "subagent_question") {
      if (failDelivery) throw new Error("temporarily unavailable");
      sent.push(message);
      delivered(message);
    }
  });
  const started = await launch(h, "question-child");
  const ask = `${started.details.sessionFile}.ask`;
  let count = await waitForCapture(h.captureCount, 0);
  writeFileSync(ask, "{partial");
  count = await waitForCapture(h.captureCount, count);
  assert.equal(readFileSync(ask, "utf8"), "{partial");

  const payload = JSON.stringify({ question: "May I proceed?" });
  writeFileSync(ask, payload);
  count = await waitForCapture(h.captureCount, count);
  assert.equal(readFileSync(ask, "utf8"), payload, "failed host delivery leaves the request available for retry");

  failDelivery = false;
  const message = await Promise.race([
    deliveredMessage,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("question was not retried")), 5000); timer.unref(); }),
  ]);
  assert.equal(message.details.question, "May I proceed?");
  assert.equal(sent.length, 1);
  assert.equal(existsSync(ask), false, "successful delivery consumes the request");
  h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
});
