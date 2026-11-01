import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollForExit } from "../pi-extension/subagents/tmux.ts";
import { registerName, writeSubagentLoadout } from "../pi-extension/subagents/session.ts";

test("aborted pane read cannot consume sentinel or exit sidecar", async () => {
  for (const action of ["resolve", "reject"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "subagent-poll-race-"));
    const session = join(dir, "session.jsonl");
    const abort = new AbortController();
    let finish!: (value: string) => void;
    let fail!: (error: Error) => void;
    const read = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
    const watched = pollForExit("%1", abort.signal, { interval: 1, sessionFile: session, readScreen: () => read });
    writeFileSync(`${session}.exit`, '{"type":"error","errorMessage":"important"}');
    abort.abort(new Error("transfer"));
    if (action === "resolve") finish("__SUBAGENT_DONE_0__"); else fail(new Error("missing pane"));
    await assert.rejects(watched, /transfer/);
    assert.match(readFileSync(`${session}.exit`, "utf8"), /important/);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delayed launch and resume block switch/fork and reload closes pending panes", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-start-race-"));
  const old = { ...process.env };
  const beforeCwd = process.cwd();
  try {
    delete process.env.PI_SUBAGENT_ALLOWED;
    process.env.TMUX = "fake";
    process.env.TMUX_PANE = "%1";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "10000";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    // Exercise the pane-oriented legacy launch tests regardless of the real user's
    // XDG configuration (which can legitimately set tmux.mode = "windows").
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    const isolatedConfigDir = join(process.env.XDG_CONFIG_HOME, "pi-interactive-subagents");
    mkdirSync(isolatedConfigDir, { recursive: true });
    writeFileSync(join(isolatedConfigDir, "config.json"), JSON.stringify({
      status: { enabled: true },
      tmux: { mode: "panes", layout: "tiled", labels: "bottom" },
    }));
    process.env.LOGFILE = join(root, "tmux.log");
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), '#!/bin/sh\necho "$*" >> "$LOGFILE"\n[ "$1" = split-window ] && echo %123\nexit 0\n', { mode: 0o700 });
    process.env.PATH = `${bin}:${old.PATH}`;
    process.chdir(root);
    const mod = await import("../pi-extension/subagents/index.ts");
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {} };
    mod.default(pi);
    const parent = join(root, "parent.jsonl"); writeFileSync(parent, '{"type":"session","id":"parent"}\n');
    const ctx = { cwd: root, sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent", getSessionDir: () => root } };
    const legacy = join(root, "legacy.jsonl"); writeFileSync(legacy, '{"type":"session","id":"legacy"}\n');
    writeFileSync(`${legacy}.loadout.json`, JSON.stringify({ toolAllowlist: "read" }));
    registerName(join(root, "artifacts", "parent"), "legacy", { sessionFile: legacy, sessionId: "legacy" });
    const legacyResult = await tools.get("subagent_message").execute("id", { name: "legacy", message: "test" }, undefined, undefined, ctx);
    assert.match(legacyResult.content[0].text, /older, incomplete, or invalid format/);
    const snapshot = { agent: "scout", toolAllowlist: "read,ask_question", toolExtensions: [], extensionAllowlist: [], model: null, thinking: null, systemPromptMode: null, identity: null, spawnable: null, autoExit: true, cwd: null, agentDir: null };
    for (const bad of [{ ...snapshot, toolAllowlist: "*" }, { ...snapshot, toolAllowlist: "" }, { ...snapshot, toolAllowlist: "read,subagent,ask_question" }, { ...snapshot, spawnable: [] }, { ...snapshot, autoExit: null }, { ...snapshot, extensionAllowlist: null }]) {
      writeFileSync(`${legacy}.loadout.json`, JSON.stringify(bad));
      const result = await tools.get("subagent_message").execute("id", { name: "legacy", message: "test" }, undefined, undefined, ctx);
      assert.match(result.content[0].text, /older, incomplete, or invalid format/);
    }
    for (const mode of ["launch", "resume"] as const) {
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      let pending: Promise<unknown>;
      if (mode === "launch") {
        pending = tools.get("subagent").execute("id", { agent: "scout", name: "pending", task: "test" }, undefined, undefined, ctx);
      } else {
        const child = join(root, "child.jsonl"); writeFileSync(child, '{"type":"session","id":"child"}\n');
        writeSubagentLoadout(child, { agent: "scout", toolAllowlist: "read,ask_question", toolExtensions: [], extensionAllowlist: [], model: null, thinking: null, systemPromptMode: null, identity: null, spawnable: null, autoExit: true, cwd: null, agentDir: null });
        registerName(join(root, "artifacts", "parent"), "finished", { sessionFile: child, sessionId: "child" });
        pending = tools.get("subagent_message").execute("id", { name: "finished", message: "test" }, undefined, undefined, ctx);
      }
      assert.deepEqual(handlers.get("session_before_switch")!({ reason: "new" }, ctx), { cancel: true });
      assert.deepEqual(handlers.get("session_before_fork")!({}, ctx), { cancel: true });
      handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
      await assert.rejects(pending, /cancelled|shutdown/i);
      assert.equal(handlers.get("session_before_switch")!({}, ctx), undefined);
    }
    const log = readFileSync(process.env.LOGFILE!, "utf8");
    assert.equal((log.match(/kill-pane/g) ?? []).length, 2);
    assert.doesNotMatch(log, /send-keys/);
  } finally {
    process.chdir(beforeCwd);
    process.env = old;
    rmSync(root, { recursive: true, force: true });
  }
});
