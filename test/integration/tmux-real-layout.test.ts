/**
 * Real tmux regression tests (no model, no Pi process, no network).
 * Creates an isolated server via tmux -L with a fresh socket name.
 * Run: NODE_OPTIONS=--experimental-strip-types node --test test/integration/tmux-real-layout.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetTmuxRuntimeForTest, configureTmuxSurfaces, createSurface, closeSurface,
  PANE_BORDER_FORMAT,
} from "../../pi-extension/subagents/tmux.ts";
import type { TmuxSurfaceConfig } from "../../pi-extension/subagents/tmux.ts";

function findTmux(): string | undefined {
  try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim(); }
  catch { return undefined; }
}
const binary = findTmux();
const base: TmuxSurfaceConfig = {
  mode: "panes", layout: "tiled", mainPaneWeight: 1.25, labels: "bottom",
  keepCompletedWindows: false, maxRetainedWindows: 4,
};

describe("real tmux layout / lifecycle (isolated socket)", { skip: binary ? false : "tmux is not installed" }, () => {
  let dir: string;
  let socket: string;
  let pane: string;
  const original = new Map<string, string | undefined>();
  const real = (...argv: string[]) => execFileSync(binary!, ["-L", socket, ...argv], { encoding: "utf8" }).trim();
  const show = (scope: "-w" | "-p", target: string, option: string) =>
    real("show-options", scope, "-v", "-t", target, option);
  const windows = () => real("list-windows", "-t", "pi-layout", "-F", "#{window_index}:#{window_name}:#{window_active}").split("\n");
  const paneCount = () => real("list-panes", "-t", pane, "-F", "#{pane_id}").split("\n").length;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagents-real-tmux-"));
    socket = `pi-subagents-test-${process.pid}`;
    real("-f", "/dev/null", "new-session", "-d", "-s", "pi-layout", "-n", "pi", "sleep 180");
    real("new-window", "-d", "-t", "pi-layout:2", "-n", "zsh", "sleep 180");
    pane = real("display-message", "-p", "-t", "pi-layout:0", "#{pane_id}");
    const shim = join(dir, "tmux");
    writeFileSync(shim, `#!/bin/sh\nexec "${binary}" -L "${socket}" "$@"\n`);
    chmodSync(shim, 0o700);
    for (const key of ["PATH", "TMUX", "TMUX_PANE"]) original.set(key, process.env[key]);
    process.env.PATH = dir + ":" + process.env.PATH;
    process.env.TMUX = "pi-subagents-test-isolated";
    process.env.TMUX_PANE = pane;
    __resetTmuxRuntimeForTest();
  });
  after(() => {
    __resetTmuxRuntimeForTest();
    for (const [key, val] of original) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    try { real("kill-server"); } catch { /* server may have exited */ }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps existing windows and focus stable with eight concurrent agent windows", () => {
    const originalWindows = windows();
    assert.ok(originalWindows.some(w => w.startsWith("2:zsh:")));
    configureTmuxSurfaces({ ...base, mode: "windows" });
    const created: string[] = [];
    try {
      for (let i = 0; i < 8; ++i) created.push(createSurface(`worker-${i}`));
      assert.ok(windows().some(w => w.startsWith("2:zsh:")));
      assert.equal(windows().length, originalWindows.length + 8);
      assert.ok(windows().some(w => w.startsWith("0:pi:1")), "main Pi window should remain selected");
    } finally {
      for (const child of created) closeSurface(child);
    }
    assert.deepEqual(windows(), originalWindows);
  });

  it("labels four panes, then restores local tmux window and pane options", async () => {
    real("set-option", "-w", "-t", pane, "pane-border-status", "top");
    real("set-option", "-w", "-t", pane, "pane-border-format", "CUSTOM #{pane_index}");
    real("set-option", "-p", "-t", pane, "@pi_subagent_name", "original-parent");
    configureTmuxSurfaces(base);
    const created: string[] = [];
    try {
      for (let i = 0; i < 4; ++i) created.push(createSurface(`scout-${i}`));
      await new Promise((r) => setTimeout(r, 250));
      assert.equal(paneCount(), 5);
      assert.equal(show("-w", pane, "pane-border-status"), "bottom");
      assert.equal(show("-w", pane, "pane-border-format"), PANE_BORDER_FORMAT);
      assert.equal(show("-p", created[0], "@pi_subagent_name"), "scout-0");
    } finally {
      for (const child of created) closeSurface(child);
    }
    assert.equal(paneCount(), 1);
    assert.equal(show("-w", pane, "pane-border-status"), "top");
    assert.equal(show("-w", pane, "pane-border-format"), "CUSTOM #{pane_index}");
    assert.equal(show("-p", pane, "@pi_subagent_name"), "original-parent");
  });

  it("reflows immediately during bursts and after lower agents finish, with orchestrator largest", () => {
    real("resize-window", "-t", pane, "-x", "170", "-y", "45");
    configureTmuxSurfaces({ ...base, layout: "balanced", mainPaneWeight: 1.25 });
    const created: string[] = [];
    const cells = () => real("list-panes", "-t", pane, "-F", "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}")
      .split("\n").map(line => {
        const [id, x, y, w, h] = line.split(" ");
        return { id, x: Number(x), y: Number(y), width: Number(w), height: Number(h) };
      });
    const assertBalanced = () => {
      const layout = cells();
      assert.equal(layout[0].id, pane, "orchestrator pane must remain first");
      const parentArea = layout[0].width * layout[0].height;
      const workerAreas = layout.slice(1).map(c => c.width * c.height);
      assert.ok(parentArea > Math.max(...workerAreas), `orchestrator not largest: ${JSON.stringify(layout)}`);
      assert.ok(Math.max(...workerAreas) / Math.min(...workerAreas) < 1.35,
        `workers not equally sized: ${JSON.stringify(layout)}`);
      const maxY = Math.max(...layout.map(c => c.y + c.height));
      const maxX = Math.max(...layout.map(c => c.x + c.width));
      const bottomBorder = show("-w", pane, "pane-border-status") === "bottom" ? 1 : 0;
      assert.equal(maxY + bottomBorder, Number(real("display-message", "-p", "-t", pane, "#{window_height}")),
        "only the pane label row may remain at bottom");
      assert.equal(maxX, Number(real("display-message", "-p", "-t", pane, "#{window_width}")),
        "no empty band at right");
    };
    try {
      for (let i = 0; i < 8; ++i) {
        created.push(createSurface(`worker-${i}`));
        assertBalanced();
      }
      closeSurface(created[3]);
      assertBalanced();
      closeSurface(created[2]);
      assertBalanced();
      const replacement = createSurface("replacement");
      created.push(replacement);
      assertBalanced();
    } finally {
      for (const child of created) {
        try { closeSurface(child); } catch { /* already gone */ }
      }
    }
    assert.equal(paneCount(), 1);
    assert.equal(real("display-message", "-p", "-t", pane, "#{pane_width}"),
      real("display-message", "-p", "-t", pane, "#{window_width}"));
  });

  it("does not overwrite manual border changes made after launch", () => {
    configureTmuxSurfaces(base);
    const child = createSurface("manual-test");
    real("set-option", "-w", "-t", pane, "pane-border-format", "manual-user-format");
    closeSurface(child);
    assert.equal(show("-w", pane, "pane-border-format"), "manual-user-format");
    real("set-option", "-w", "-u", "-t", pane, "pane-border-format");
    real("set-option", "-w", "-u", "-t", pane, "pane-border-status");
    real("set-option", "-p", "-u", "-t", pane, "@pi_subagent_name");
  });

  it("does not replace a manually zoomed pane's layout while agents run", async () => {
    configureTmuxSurfaces(base);
    const child = createSurface("zoom-scout");
    try {
      real("resize-pane", "-Z", "-t", pane);
      assert.equal(real("display-message", "-p", "-t", pane, "#{window_zoomed_flag}"), "1");
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(real("display-message", "-p", "-t", pane, "#{window_zoomed_flag}"), "1");
    } finally {
      closeSurface(child);
    }
  });

  it("supports nested agents in the same tmux session without moving user windows", () => {
    configureTmuxSurfaces({ ...base, mode: "windows" });
    const outer = createSurface("outer-worker");
    let inner: string | undefined;
    try {
      process.env.TMUX_PANE = outer;
      inner = createSurface("nested-scout");
      assert.ok(windows().some(w => w.startsWith("2:zsh:")));
      assert.equal(windows().length, 4);
    } finally {
      process.env.TMUX_PANE = pane;
      if (inner) closeSurface(inner);
      closeSurface(outer);
    }
    assert.equal(windows().length, 2);
  });

  it("preserves child ownership across module /reload and new mode selection", async () => {
    configureTmuxSurfaces(base);
    const oldChild = createSurface("reload-scanner");
    const reloaded = await import(`../../pi-extension/subagents/tmux.ts?reload=${Date.now()}`);
    reloaded.configureTmuxSurfaces({ ...base, mode: "windows", labels: "off" });
    reloaded.closeSurface(oldChild);
    assert.equal(paneCount(), 1);
    assert.ok(windows().some(w => w.startsWith("2:zsh:")));
  });

  it("retains at most two completed windows, never a cancelled one", () => {
    configureTmuxSurfaces({ ...base, mode: "windows", keepCompletedWindows: true, maxRetainedWindows: 2 });
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const child = createSurface(`done-${i}`);
      created.push(child);
      closeSurface(child, { completed: true });
    }
    assert.equal(windows().filter(w => w.includes("done-")).length, 2);
    const aborted = createSurface("abort");
    closeSurface(aborted);
    assert.equal(windows().filter(w => w.includes("abort")).length, 0);
    // Explicitly clean up the retained inspection windows in our isolated session.
    for (const w of windows()) {
      if (w.includes("done-")) real("kill-window", "-t", `pi-layout:${w.split(":")[0]}`);
    }
  });
});
