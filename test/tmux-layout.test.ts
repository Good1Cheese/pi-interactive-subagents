import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWeightedLayout } from "../pi-extension/subagents/weighted-layout.ts";
import {
  configureTmuxSurfaces, createSurface, closeSurface, PANE_BORDER_FORMAT,
  tmuxDisplayName, tmuxSurfaceStatus, isCleanSurfaceCompletion, rebalanceCurrentTmuxWindow, __resetTmuxRuntimeForTest,
} from "../pi-extension/subagents/tmux.ts";
import type { TmuxSurfaceConfig } from "../pi-extension/subagents/tmux.ts";

const baseConfig: TmuxSurfaceConfig = {
  mode: "panes", layout: "tiled", mainPaneWeight: 1.25, labels: "bottom",
  keepCompletedWindows: false, maxRetainedWindows: 4,
};
const initialState = () => ({
  nextPane: 200, nextWindow: 10, seq: 0, failSetOption: false, failKillPaneOnce: 0,
  windows: {
    "@7": { index: 1, title: "pi", options: {} as Record<string, string>, panes: ["%100"], layout: "original-pi" },
    "@8": { index: 2, title: "zsh", options: {} as Record<string, string>, panes: ["%101"], layout: "original-zsh" },
  } as Record<string, { index: number; title: string; options: Record<string, string>; panes: string[]; layout: string }>,
  paneOptions: {} as Record<string, Record<string, string>>,
});

async function withFakeTmux(run: (ctx: {
  trace: () => string[][];
  read: () => ReturnType<typeof initialState>;
  mutate: (fn: (state: ReturnType<typeof initialState>) => void) => void;
}) => Promise<void>, initial?: (s: ReturnType<typeof initialState>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-tmux-layout-"));
  const fake = join(dir, "tmux");
  const tracePath = join(dir, "trace.jsonl");
  const statePath = join(dir, "state.json");
  writeFileSync(tracePath, "");
  const state = initialState();
  initial?.(state);
  writeFileSync(statePath, JSON.stringify(state));
  const helper = fileURLToPath(new URL("./helpers/fake-tmux.mjs", import.meta.url));
  writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`);
  chmodSync(fake, 0o700);
  const names = ["PATH", "TMUX", "TMUX_PANE", "FAKE_TMUX_STATE", "FAKE_TMUX_TRACE", "PI_SUBAGENT_NAME"];
  const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  __resetTmuxRuntimeForTest();
  try {
    process.env.PATH = dir + ":" + (env.PATH ?? "");
    process.env.TMUX = "/fake/socket";
    process.env.TMUX_PANE = "%100";
    process.env.FAKE_TMUX_STATE = statePath;
    process.env.FAKE_TMUX_TRACE = tracePath;
    delete process.env.PI_SUBAGENT_NAME;
    await run({
      trace: () => readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
      read: () => JSON.parse(readFileSync(statePath, "utf8")),
      mutate: (fn) => { const next = JSON.parse(readFileSync(statePath, "utf8")); fn(next); writeFileSync(statePath, JSON.stringify(next)); },
    });
  } finally {
    __resetTmuxRuntimeForTest();
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const has = (trace: string[][], command: string, rest: string[] = []) =>
  trace.some((args) => args[0] === command && rest.every((part) => args.includes(part)));

const tick = () => new Promise((resolve) => setTimeout(resolve, 210));

describe("tmux layout and stable instance labels", () => {
  it("reflows surviving children after bottom panels close and keeps orchestrator larger", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces({ ...baseConfig, layout: "balanced", mainPaneWeight: 1.25 });
      const children = Array.from({ length: 4 }, (_, i) => createSurface(`worker-${i}`));
      await tick();
      const custom = () => ctx.trace().filter(args => args[0] === "select-layout" && args.at(-1)?.includes(","));
      assert.equal(custom().at(-1)?.at(-1), createWeightedLayout(170, 45, 5, 1.25)!.layout);
      // The same scenario as the screenshot: the lower panes have disappeared,
      // and the survivors must expand into the empty space.
      closeSurface(children[3]);
      closeSurface(children[2]);
      await tick();
      assert.equal(ctx.read().windows["@7"].panes.length, 3);
      assert.equal(custom().at(-1)?.at(-1), createWeightedLayout(170, 45, 3, 1.25)!.layout);
      const count = custom().length;
      const added = createSurface("fresh-scout");
      await tick();
      assert.equal(custom().at(-1)?.at(-1), createWeightedLayout(170, 45, 4, 1.25)!.layout);
      assert.ok(custom().length > count);
      closeSurface(children[0]);
      closeSurface(children[1]);
      closeSurface(added);
      assert.equal(ctx.read().windows["@7"].panes.length, 1);
    });
  });

  it("keeps failed kill-pane tracked and retries cleanup without leaving orphan panes", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces({ ...baseConfig, layout: "balanced" });
      const child = createSurface("worker");
      ctx.mutate(s => { s.failKillPaneOnce = 1; });
      closeSurface(child);
      assert.equal(ctx.read().windows["@7"].panes.length, 2);
      assert.match(tmuxSurfaceStatus(), /pendingCleanups=1/);
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(ctx.read().windows["@7"].panes.length, 1);
      assert.match(tmuxSurfaceStatus(), /pendingCleanups=0/);
      assert.match(tmuxSurfaceStatus(), /runningSurfaces=0/);
    });
  });

  it("falls back to built-in tiled when tmux rejects weighted custom layouts", async () => {
    await withFakeTmux(async ctx => {
      configureTmuxSurfaces({ ...baseConfig, layout: "balanced" });
      const child = createSurface("worker");
      await tick();
      assert.ok(has(ctx.trace(), "select-layout", ["tiled"]));
      assert.equal(ctx.read().windows["@7"].panes.length, 2);
      closeSurface(child);
    }, state => { (state as any).failCustomLayout = true; });
  });

  it("resizes automatic layout with the terminal instead of treating resize as manual", async () => {
    await withFakeTmux(async ctx => {
      configureTmuxSurfaces({ ...baseConfig, layout: "balanced" });
      const first = createSurface("first");
      await tick();
      ctx.mutate(s => { (s as any).width = 200; s.windows["@7"].layout = "tmux-terminal-resized"; });
      const second = createSurface("second");
      await tick();
      const custom = ctx.trace().filter(args => args[0] === "select-layout" && args.at(-1)?.includes(","));
      assert.equal(custom.at(-1)?.at(-1), createWeightedLayout(200, 45, 3, 1.25)!.layout);
      closeSurface(first);
      closeSurface(second);
    });
  });

  it("finalizes cleanup when the pane was already removed by tmux", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const child = createSurface("gone");
      ctx.mutate(s => { s.windows["@7"].panes = ["%100"]; });
      closeSurface(child);
      assert.match(tmuxSurfaceStatus(), /runningSurfaces=0/);
      assert.match(tmuxSurfaceStatus(), /pendingCleanups=0/);
      assert.equal(ctx.read().windows["@7"].options["pane-border-status"], undefined);
    });
  });

  it("labels all managed panes and restores inherited options on last exit", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const a = createSurface("auth-scout");
      const b = createSurface("api-worker");
      await tick();
      assert.deepEqual([a, b], ["%200", "%201"]);
      assert.equal(ctx.read().windows["@7"].options["pane-border-status"], "bottom");
      assert.equal(ctx.read().windows["@7"].options["pane-border-format"], PANE_BORDER_FORMAT);
      assert.equal(ctx.read().paneOptions["%100"]["@pi_subagent_name"], "Pi - orchestrator");
      assert.equal(ctx.read().paneOptions["%200"]["@pi_subagent_name"], "auth-scout");
      assert.ok(has(ctx.trace(), "select-layout", ["tiled"]));
      closeSurface(a);
      assert.equal(ctx.read().windows["@7"].options["pane-border-status"], "bottom");
      closeSurface(b);
      assert.equal(ctx.read().windows["@7"].options["pane-border-status"], undefined);
      assert.equal(ctx.read().windows["@7"].options["pane-border-format"], undefined);
      assert.equal(ctx.read().paneOptions["%100"]?.["@pi_subagent_name"], undefined);
      assert.equal(ctx.read().windows["@8"].index, 2);
    });
  });

  it("restores original local values and preserves later manual overrides", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const a = createSurface("worker-1");
      await tick();
      ctx.mutate((state) => { state.windows["@7"].options["pane-border-format"] = "user changed format"; });
      closeSurface(a);
      assert.equal(ctx.read().windows["@7"].options["pane-border-format"], "user changed format");
      assert.equal(ctx.read().windows["@7"].options["pane-border-status"], "top");
    }, (state) => { state.windows["@7"].options["pane-border-status"] = "top"; });
  });

  it("refuses to relayout pre-existing user panes, then safely restores original geometry", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const pane = createSurface("scout");
      await tick();
      assert.ok(!has(ctx.trace(), "select-layout", ["tiled"]));
      closeSurface(pane);
      assert.ok(has(ctx.trace(), "select-layout", ["original-pi"]));
    }, (state) => { state.windows["@7"].panes.push("%105"); });
  });

  it("does not override a user's active tmux zoom", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const first = createSurface("first");
      const second = createSurface("second");
      const beforeZoom = ctx.trace().length;
      ctx.mutate((state) => { (state.windows["@7"] as any).zoomed = true; });
      closeSurface(second);
      assert.ok(!has(ctx.trace().slice(beforeZoom), "select-layout"));
      closeSurface(first);
    });
  });

  it("explicitly rebalances a manually changed, fully-owned pane window", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces({ ...baseConfig, layout: "balanced", mainPaneWeight: 1.25 });
      createSurface("scout");
      ctx.mutate((state) => { state.windows["@7"].layout = "user-layout"; });
      const result = rebalanceCurrentTmuxWindow();
      assert.deepEqual(result, { ok: true, message: "Rebalanced 2 managed panes using balanced layout." });
      const custom = ctx.trace().filter(args => args[0] === "select-layout" && args.at(-1)?.includes(","));
      assert.equal(custom.at(-1)?.at(-1), createWeightedLayout(170, 45, 2, 1.25)!.layout);
      assert.equal(ctx.read().windows["@7"].panes.length, 2);
    });
  });

  it("refuses manual rebalancing when panes are foreign or the window is zoomed", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      createSurface("scout");
      ctx.mutate((state) => { state.windows["@7"].panes.push("%105"); });
      const beforeForeign = ctx.trace().length;
      const foreign = rebalanceCurrentTmuxWindow();
      assert.equal(foreign.ok, false);
      assert.match(foreign.message, /unmanaged or pre-existing panes/);
      assert.ok(!has(ctx.trace().slice(beforeForeign), "select-layout"));
      ctx.mutate((state) => { state.windows["@7"].panes.pop(); (state.windows["@7"] as any).zoomed = true; });
      const beforeZoom = ctx.trace().length;
      const zoomed = rebalanceCurrentTmuxWindow();
      assert.equal(zoomed.ok, false);
      assert.match(zoomed.message, /Unzoom it/);
      assert.ok(!has(ctx.trace().slice(beforeZoom), "select-layout"));
      assert.equal(ctx.read().windows["@7"].panes.length, 2);
    });
  });

  it("does not restore a stale layout over a user's manual layout change", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const pane = createSurface("scout");
      ctx.mutate((s) => { s.windows["@7"].layout = "user-tiles"; });
      closeSurface(pane);
      assert.ok(!has(ctx.trace(), "select-layout", ["original-pi"]));
    }, (s) => { s.windows["@7"].panes.push("%105"); });
  });

  it("releases labels on /reload when labels switch off, preserving child tracking", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const a = createSurface("scout");
      configureTmuxSurfaces({ ...baseConfig, labels: "off" });
      assert.equal(ctx.read().windows["@7"].options["pane-border-format"], undefined);
      closeSurface(a);
      assert.equal(ctx.read().windows["@7"].panes.length, 1);
    });
  });

  it("opens windows at unused indexes without moving existing zsh or stealing focus", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces({ ...baseConfig, mode: "windows", labels: "off" });
      const a = createSurface("scout-cedar");
      const b = createSurface("worker-ember");
      assert.deepEqual([a, b], ["%200", "%201"]);
      const indices = Object.values(ctx.read().windows).map(w => w.index);
      assert.deepEqual(indices, [1, 2, 3, 4]);
      assert.equal(ctx.read().windows["@8"].title, "zsh");
      assert.ok(ctx.trace().every(args => !args.includes("-a") && !args.includes("-b")));
      assert.ok(has(ctx.trace(), "new-window", ["-d", "$3:", "-n", "scout-cedar"]));
      closeSurface(a);
      closeSurface(b);
      assert.equal(Object.keys(ctx.read().windows).length, 2);
    });
  });

  it("keeps a bounded history of completed windows without retaining cancelled ones", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces({ ...baseConfig, mode: "windows", labels: "off", keepCompletedWindows: true, maxRetainedWindows: 2 });
      const a = createSurface("a");
      closeSurface(a, { completed: true });
      assert.ok(Object.values(ctx.read().windows).some(w => w.title === "done-a"));
      const b = createSurface("b");
      closeSurface(b, { completed: true });
      const c = createSurface("c");
      closeSurface(c, { completed: true });
      assert.ok(!Object.values(ctx.read().windows).some(w => w.title === "done-a"));
      assert.equal(Object.values(ctx.read().windows).filter(w => w.title.startsWith("done-")).length, 2);
      const d = createSurface("abort");
      closeSurface(d);
      assert.ok(!Object.values(ctx.read().windows).some(w => w.title === "done-abort"));
      assert.match(tmuxSurfaceStatus(), /retainedWindows=2/);
    });
  });

  it("does not abort a child launch when a cosmetic tmux option fails", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const pane = createSurface("scout-safe");
      assert.equal(pane, "%200");
      assert.match(tmuxSurfaceStatus(), /warnings=1/);
      ctx.mutate(s => { s.failSetOption = false; });
      closeSurface(pane);
      assert.equal(ctx.read().windows["@7"].panes.length, 1);
    }, s => { s.failSetOption = true; });
  });

  it("retains tmux ownership across an actual module import/reload", async () => {
    await withFakeTmux(async (ctx) => {
      configureTmuxSurfaces(baseConfig);
      const pane = createSurface("running-on-reload");
      const reloaded = await import(`../pi-extension/subagents/tmux.ts?reload=${Date.now()}`);
      reloaded.configureTmuxSurfaces({ ...baseConfig, mode: "windows", labels: "off" });
      reloaded.closeSurface(pane);
      assert.equal(ctx.read().windows["@7"].panes.length, 1);
      assert.equal(ctx.read().windows["@7"].options["pane-border-status"], undefined);
    });
  });

  it("never retains an error-sidecar or nonzero exit while child process may still exist", () => {
    assert.equal(isCleanSurfaceCompletion({ reason: "sentinel", exitCode: 0, source: "shell" }), true);
    assert.equal(isCleanSurfaceCompletion({ reason: "sentinel", exitCode: 1, source: "shell" }), false);
    assert.equal(isCleanSurfaceCompletion({ reason: "sentinel", exitCode: 0, source: "hook" }), false);
    assert.equal(isCleanSurfaceCompletion({ reason: "error", exitCode: 1 }), false);
    assert.equal(isCleanSurfaceCompletion({ reason: "done", exitCode: 0 }), false);
  });

  it("sanitizes pane/window titles without changing the internal agent name", () => {
    assert.equal(tmuxDisplayName("auth-scout"), "auth-scout");
    assert.equal(tmuxDisplayName("x#[fg=red]\u202e\u001b"), "x_[fg=red]");
    const a = "the-extremely-long-role-name-that-starts-the-same-aaaa";
    const b = "the-extremely-long-role-name-that-starts-the-same-bbbb";
    assert.notEqual(tmuxDisplayName(a), tmuxDisplayName(b));
    assert.ok(tmuxDisplayName(a).length <= 32);
  });
});
