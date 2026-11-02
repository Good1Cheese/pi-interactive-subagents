import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { readSubagentLoadout } from "../pi-extension/subagents/session.ts";

test("an explicitly empty inherited spawn allowlist never becomes unrestricted", () => {
  const moduleUrl = pathToFileURL(resolve("pi-extension/subagents/index.ts")).href;
  const code = `const m = await import(${JSON.stringify(moduleUrl)}); if (m.__test__.discoverAgentDefinitions().length !== 0) process.exit(1);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, PI_SUBAGENT_ALLOWED: "" }, stdio: "pipe" });
});

test("spawn and resume preserve YAML tool arrays and the absent-tools default", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-loadout-"));
  const old = { ...process.env };
  const previousCwd = process.cwd();
  try {
    delete process.env.PI_SUBAGENT_ALLOWED;
    process.env.TMUX = "fake"; process.env.TMUX_PANE = "%1";
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
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
    process.env.TMUX_LOG = join(root, "tmux.log");
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "tmux"), '#!/bin/sh\necho "$*" >> "$TMUX_LOG"\n[ "$1" = split-window ] && echo %123\nexit 0\n', { mode: 0o700 });
    process.env.PATH = `${bin}:${old.PATH}`;
    const agentDir = join(root, ".pi", "agents"); mkdirSync(agentDir, { recursive: true });
    process.chdir(root);
    const mod = await import("../pi-extension/subagents/index.ts");
    const handlers = new Map<string, Function>();
    const tools = new Map<string, any>();
    const pi: any = {
      events: createEventBus(),
      on: (name: string, fn: Function) => handlers.set(name, fn),
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {},
    };
    mod.default(pi);
    const parent = join(root, "parent.jsonl"); writeFileSync(parent, '{"type":"session","id":"parent"}\n');
    const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionFile: () => parent, getSessionId: () => "parent", getSessionDir: () => root } };
    for (const [name, field, expected] of [
      ["restricted", "tools: [read, grep]\n", "read,grep,ask_question"],
      ["defaulted", "", "read,write,edit,bash,ask_question"],
    ]) {
      writeFileSync(join(agentDir, `${name}.md`), `---\nname: ${name}\n${field}auto-exit: true\n---\nTest profile`);
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      const started = await tools.get("subagent").execute("id", { agent: name, name, task: "test" }, undefined, undefined, ctx);
      const sessionFile = started.details.sessionFile;
      const loadout = readSubagentLoadout(sessionFile)!;
      assert.equal(loadout.toolAllowlist, expected);
      assert.match(readFileSync(started.details.launchScriptFile, "utf8"), new RegExp(`--tools '${expected}'`));
      writeFileSync(sessionFile, '{"type":"session","id":"child"}\n');
      handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      await new Promise((resolve) => setImmediate(resolve));
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      const resumed = await tools.get("subagent_message").execute("id", { name, message: "resume" }, undefined, undefined, ctx);
      assert.equal(resumed.details.status, "started");
      assert.match(readFileSync(resumed.details.launchScriptFile, "utf8"), new RegExp(`--tools '${expected}'`));
      handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const [index, field] of ["tools: null", "tools: []", "tools: [read, null]", "subagent_agents: null", "auto-exit: null", "session-mode: null"].entries()) {
      const path = join(agentDir, `invalid-${index}.md`);
      writeFileSync(path, `---\nname: bad\n${field}\n---\nBad profile`);
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      await assert.rejects(tools.get("subagent").execute("id", { agent: "bad", name: "bad", task: "test" }, undefined, undefined, ctx), /Invalid agent field/);
      handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      unlinkSync(path);
    }
  } finally {
    process.chdir(previousCwd); process.env = old; rmSync(root, { recursive: true, force: true });
  }
});
