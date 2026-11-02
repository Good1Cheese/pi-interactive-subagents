import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";
import { readSubagentLoadout } from "../pi-extension/subagents/session.ts";
import { __resetTmuxRuntimeForTest } from "../pi-extension/subagents/tmux.ts";

test("an explicitly empty inherited spawn allowlist never becomes unrestricted", () => {
  const moduleUrl = pathToFileURL(resolve("pi-extension/subagents/index.ts")).href;
  const code = `const m = await import(${JSON.stringify(moduleUrl)}); if (m.__test__.discoverAgentDefinitions().length !== 0) process.exit(1);`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, PI_SUBAGENT_ALLOWED: "" }, stdio: "pipe" });
});

test("spawn and resume preserve YAML tool arrays and the absent-tools default", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-loadout-"));
  const old = { ...process.env };
  const previousCwd = process.cwd();
  let shutdown: (() => unknown) | undefined;
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
    const childEnvCapture = join(root, "tui-child-env.txt");
    process.env.PI_CHILD_ENV_CAPTURE = childEnvCapture;
    process.env.PI_SUBAGENT_LIFECYCLE_FILE = "parent-hostile-lifecycle";
    process.env.PI_SUBAGENT_SURFACE = "parent-hostile-surface";
    process.env.PI_SUBAGENT_STEERING_SOCKET = "parent-hostile-socket";
    process.env.PI_SUBAGENT_STEERING_GENERATION = "parent-hostile-generation";
    process.env.PI_AUTONOMY_CHILD_ROOT_RUN_ID = "parent-hostile-root-run";
    process.env.PI_AUTONOMY_PARENT_SENTINEL = "preserve-parent-config";
    writeFileSync(join(bin, "tmux"), '#!/bin/sh\necho "$*" >> "$TMUX_LOG"\n[ "$1" = split-window ] && echo %123\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(bin, "pi"), '#!/bin/sh\nprintf \'%s\\n\' "PI_SUBAGENT_LIFECYCLE_FILE=${PI_SUBAGENT_LIFECYCLE_FILE-<unset>}" "PI_SUBAGENT_SURFACE=${PI_SUBAGENT_SURFACE-<unset>}" "PI_SUBAGENT_STEERING_SOCKET=${PI_SUBAGENT_STEERING_SOCKET-<unset>}" "PI_SUBAGENT_STEERING_GENERATION=${PI_SUBAGENT_STEERING_GENERATION-<unset>}" "PI_SUBAGENT_ID=${PI_SUBAGENT_ID-<unset>}" "PI_AUTONOMY_CHILD_ROOT_RUN_ID=${PI_AUTONOMY_CHILD_ROOT_RUN_ID-<unset>}" "PI_AUTONOMY_PARENT_SENTINEL=${PI_AUTONOMY_PARENT_SENTINEL-<unset>}" >> "$PI_CHILD_ENV_CAPTURE"\nexit 0\n', { mode: 0o700 });
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
    shutdown = () => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    for (const [name, field, expected] of [
      ["restricted", "tools: [read, grep]\n", "read,grep,ask_question"],
      ["defaulted", "", "read,write,edit,bash,ask_question"],
    ]) {
      const childCwd = join(root, `${name}-cwd`);
      mkdirSync(childCwd);
      writeFileSync(join(agentDir, `${name}.md`), `---\nname: ${name}\ncwd: ${childCwd}\n${field}auto-exit: true\n---\nTest profile`);
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      const started = await tools.get("subagent").execute("id", { agent: name, name, task: "test" }, undefined, undefined, ctx);
      const sessionFile = started.details.sessionFile;
      const loadout = readSubagentLoadout(sessionFile)!;
      assert.equal(loadout.toolAllowlist, expected);
      assert.match(readFileSync(started.details.launchScriptFile, "utf8"), new RegExp(`'--tools' '${expected}'`));
      execFileSync("bash", [started.details.launchScriptFile], { env: process.env, stdio: "pipe" });
      writeFileSync(sessionFile, '{"type":"session","id":"child"}\n');
      handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      await new Promise((resolve) => setImmediate(resolve));
      handlers.get("session_start")!({ reason: "startup" }, ctx);
      const resumed = await tools.get("subagent_message").execute("id", { name, message: "resume" }, undefined, undefined, ctx);
      assert.equal(resumed.details.status, "started");
      assert.match(readFileSync(resumed.details.launchScriptFile, "utf8"), new RegExp(`'--tools' '${expected}'`));
      execFileSync("bash", [resumed.details.launchScriptFile], { env: process.env, stdio: "pipe" });
      const capturedBeforeMissingCwd = readFileSync(childEnvCapture, "utf8");
      rmSync(childCwd, { recursive: true });
      for (const script of [started.details.launchScriptFile, resumed.details.launchScriptFile]) {
        execFileSync("bash", [script], { env: process.env, stdio: "pipe" });
        assert.equal(readFileSync(childEnvCapture, "utf8") === capturedBeforeMissingCwd, true, "failed cd must not launch Pi in the wrong directory");
      }
      handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      await new Promise((resolve) => setImmediate(resolve));
    }
    const capturedEnv = readFileSync(childEnvCapture, "utf8").trim().split("\n");
    const envKeys = ["PI_SUBAGENT_LIFECYCLE_FILE", "PI_SUBAGENT_SURFACE", "PI_SUBAGENT_STEERING_SOCKET", "PI_SUBAGENT_STEERING_GENERATION", "PI_SUBAGENT_ID", "PI_AUTONOMY_CHILD_ROOT_RUN_ID", "PI_AUTONOMY_PARENT_SENTINEL"];
    assert.equal(capturedEnv.length, envKeys.length * 4, "executed spawn and resume launch scripts reached fake Pi");
    for (let index = 0; index < 4; index++) {
      const env = Object.fromEntries(capturedEnv.slice(index * envKeys.length, (index + 1) * envKeys.length).map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      assert.equal(env.PI_SUBAGENT_LIFECYCLE_FILE, "<unset>");
      assert.notEqual(env.PI_SUBAGENT_SURFACE, "parent-hostile-surface");
      assert.notEqual(env.PI_SUBAGENT_STEERING_SOCKET, "parent-hostile-socket");
      assert.notEqual(env.PI_SUBAGENT_STEERING_GENERATION, "parent-hostile-generation");
      assert.ok(env.PI_SUBAGENT_ID && env.PI_SUBAGENT_ID !== "<unset>");
      assert.equal(env.PI_AUTONOMY_CHILD_ROOT_RUN_ID, "<unset>");
      assert.equal(env.PI_AUTONOMY_PARENT_SENTINEL, "preserve-parent-config");
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
    await shutdown?.();
    await new Promise((resolve) => setImmediate(resolve));
    __resetTmuxRuntimeForTest();
    process.chdir(previousCwd); process.env = old; rmSync(root, { recursive: true, force: true });
  }
});
