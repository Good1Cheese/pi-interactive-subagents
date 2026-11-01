/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ensurePrivateDir, writePrivateFile } from "./private-files.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// --- Layout, labels, and managed window ownership ---

export interface TmuxSurfaceConfig {
  mode: "panes" | "windows";
  layout: "tiled" | "even-horizontal" | "even-vertical" | "main-vertical" | "main-horizontal";
  labels: "bottom" | "top" | "off";
  keepCompletedWindows: boolean;
  maxRetainedWindows: number;
}

const DEFAULT_SURFACE_CONFIG: TmuxSurfaceConfig = {
  mode: "panes", layout: "tiled", labels: "bottom",
  keepCompletedWindows: false, maxRetainedWindows: 4,
};
let surfaceConfig: TmuxSurfaceConfig = { ...DEFAULT_SURFACE_CONFIG };

export const PANE_BORDER_FORMAT = "#{?pane_active,#[bold],} #{?@pi_subagent_name,#{@pi_subagent_name},#{pane_title}} #[default]";

/** Keep state across Pi /reload: the previous module's watchers hand off to the new module. */
const SURFACES_KEY = Symbol.for("pi-interactive-subagents/tmux-state-v2");
interface SavedOption { present: boolean; value?: string }
interface OwnedOption {
  previous: SavedOption;
  applied?: string;
  relinquished?: boolean;
}
interface ManagedWindow {
  id: string;
  parent: string;
  baselinePanes: Set<string>;
  baselineLayout: string;
  children: Set<string>;
  borderStatus: OwnedOption;
  borderFormat: OwnedOption;
  parentLabel: OwnedOption;
  automaticLayout: boolean;
  lastKnownLayout?: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface ManagedSurface { mode: "panes" | "windows"; name: string; windowId?: string }
interface TmuxRuntime {
  surfaces: Map<string, ManagedSurface>;
  windows: Map<string, ManagedWindow>;
  retained: string[];
  warnings: Set<string>;
}
const runtime: TmuxRuntime =
  ((globalThis as any)[SURFACES_KEY] ??= {
    surfaces: new Map(), windows: new Map(), retained: [], warnings: new Set(),
  });

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8" }).replace(/\r?\n$/, "");
}

function warnCosmetic(action: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const key = `${action}: ${detail.slice(0, 180)}`;
  if (runtime.warnings.has(key)) return;
  runtime.warnings.add(key);
  console.warn(`[pi-subagents/tmux] ${action}: ${detail}`);
}

/** Protect the tmux format parser and UI against control, bidi and style injection. */
export function tmuxDisplayName(name: string, maxLength = 32): string {
  const cleaned = name.normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .replace(/#/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "subagent";
  const chars = Array.from(cleaned);
  if (chars.length <= maxLength) return cleaned;
  const suffix = requireNameHash(name);
  return chars.slice(0, Math.max(1, maxLength - suffix.length - 1)).join("") + "~" + suffix;
}

function requireNameHash(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 7);
}

/** Only query a window/pane's *local* options; inherited global options are not ours. */
function readLocalOption(scope: "-w" | "-p", target: string, option: string): SavedOption {
  const localOptions = tmux("show-options", scope, "-t", target);
  const present = localOptions.split("\n").some((line) => line === option || line.startsWith(`${option} `));
  return present
    ? { present: true, value: tmux("show-options", scope, "-v", "-t", target, option) }
    : { present: false };
}

function saved(scope: "-w" | "-p", target: string, option: string): OwnedOption {
  return { previous: readLocalOption(scope, target, option) };
}

function applyOwned(scope: "-w" | "-p", target: string, option: string, owned: OwnedOption, value: string): void {
  if (owned.relinquished) return;
  if (owned.applied !== undefined) {
    const current = readLocalOption(scope, target, option);
    if (!current.present || current.value !== owned.applied) {
      owned.relinquished = true; // User or another extension changed it; stop managing.
      return;
    }
  }
  tmux("set-option", scope, "-t", target, option, value);
  owned.applied = value;
}

function restoreOwned(scope: "-w" | "-p", target: string, option: string, owned: OwnedOption): void {
  if (owned.applied === undefined || owned.relinquished) return;
  const current = readLocalOption(scope, target, option);
  if (!current.present || current.value !== owned.applied) return; // Do not undo user changes.
  if (owned.previous.present) {
    tmux("set-option", scope, "-t", target, option, owned.previous.value ?? "");
  } else {
    tmux("set-option", scope, "-u", "-t", target, option);
  }
  owned.applied = undefined;
}

function listWindowPanes(windowId: string): Set<string> {
  return new Set(tmux("list-panes", "-t", windowId, "-F", "#{pane_id}").split("\n").filter(Boolean));
}
function windowLayout(windowId: string): string {
  return tmux("display-message", "-p", "-t", windowId, "#{window_layout}");
}
function windowIdOf(pane: string): string {
  const id = tmux("display-message", "-p", "-t", pane, "#{window_id}");
  if (!/^@\d+$/.test(id)) throw new Error(`Unexpected tmux window id: ${id}`);
  return id;
}

function snapshotWindow(parent: string): ManagedWindow {
  const id = windowIdOf(parent);
  return {
    id, parent,
    baselinePanes: listWindowPanes(id),
    baselineLayout: windowLayout(id),
    children: new Set(),
    borderStatus: saved("-w", id, "pane-border-status"),
    borderFormat: saved("-w", id, "pane-border-format"),
    parentLabel: saved("-p", parent, "@pi_subagent_name"),
    automaticLayout: true,
  };
}

function applyLabels(state: ManagedWindow, pane: string, name: string): void {
  if (surfaceConfig.labels === "off") return;
  try {
    applyOwned("-w", state.id, "pane-border-status", state.borderStatus, surfaceConfig.labels);
    applyOwned("-w", state.id, "pane-border-format", state.borderFormat, PANE_BORDER_FORMAT);
    if (state.baselinePanes.has(state.parent)) {
      const parentName = process.env.PI_SUBAGENT_NAME || "Pi";
      applyOwned("-p", state.parent, "@pi_subagent_name", state.parentLabel,
        tmuxDisplayName(`${parentName} - orchestrator`));
    }
    tmux("set-option", "-p", "-t", pane, "@pi_subagent_name", tmuxDisplayName(name));
  } catch (err) {
    warnCosmetic("could not apply pane labels", err);
  }
}

function restoreLabels(state: ManagedWindow): void {
  try { restoreOwned("-w", state.id, "pane-border-status", state.borderStatus); }
  catch (err) { warnCosmetic("restore pane-border-status", err); }
  try { restoreOwned("-w", state.id, "pane-border-format", state.borderFormat); }
  catch (err) { warnCosmetic("restore pane-border-format", err); }
  try { restoreOwned("-p", state.parent, "@pi_subagent_name", state.parentLabel); }
  catch (err) { warnCosmetic("restore orchestrator pane label", err); }
}

/** When user changes layout, do not apply an automatic layout again. */
function verifyLayoutOwner(state: ManagedWindow): void {
  if (!state.automaticLayout || state.lastKnownLayout === undefined) return;
  try {
    if (windowLayout(state.id) !== state.lastKnownLayout) state.automaticLayout = false;
  } catch (err) { state.automaticLayout = false; warnCosmetic("inspect window layout", err); }
}

function canRebalance(state: ManagedWindow): boolean {
  if (!state.automaticLayout || state.children.size === 0 || state.baselinePanes.size !== 1) return false;
  // Never discard an active tmux zoom to improve an automatic layout.
  try {
    if (tmux("display-message", "-p", "-t", state.id, "#{window_zoomed_flag}") === "1") return false;
  } catch (err) { warnCosmetic("inspect tmux zoom", err); return false; }
  // Do not re-layout unrelated user or nested-agent panes.
  try {
    const allowed = new Set([...state.baselinePanes, ...state.children]);
    return [...listWindowPanes(state.id)].every((id) => allowed.has(id));
  } catch (err) { warnCosmetic("inspect panes before layout", err); return false; }
}

function scheduleRebalance(state: ManagedWindow): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  if (!canRebalance(state)) return;
  try { state.lastKnownLayout = windowLayout(state.id); }
  catch (err) { warnCosmetic("inspect layout before rebalancing", err); return; }
  state.timer = setTimeout(() => {
    state.timer = undefined;
    if (!canRebalance(state)) return;
    verifyLayoutOwner(state);
    if (!state.automaticLayout) return;
    try {
      tmux("select-layout", "-t", state.id, surfaceConfig.layout);
      state.lastKnownLayout = windowLayout(state.id);
    } catch (err) { warnCosmetic("could not rebalance panes", err); }
  }, 120);
  state.timer.unref?.();
}

/** Config changes on /reload do not reclassify already spawned panes/windows. */
export function configureTmuxSurfaces(config: TmuxSurfaceConfig): void {
  const previous = surfaceConfig;
  surfaceConfig = { ...config };
  for (const state of runtime.windows.values()) {
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    if (config.labels === "off" && previous.labels !== "off") restoreLabels(state);
    if (config.mode !== previous.mode || config.layout !== previous.layout) {
      // Existing panes stay in their original mode and retain their layout.
      state.automaticLayout = false;
    }
  }
}

/** Test-only: reset process-shared state after disposable fake-tmux sessions. */
export function __resetTmuxRuntimeForTest(): void {
  for (const state of runtime.windows.values()) if (state.timer) clearTimeout(state.timer);
  runtime.surfaces.clear();
  runtime.windows.clear();
  runtime.retained.length = 0;
  runtime.warnings.clear();
  surfaceConfig = { ...DEFAULT_SURFACE_CONFIG };
}

export function tmuxSurfaceStatus(): string {
  return `mode=${surfaceConfig.mode}, layout=${surfaceConfig.layout}, labels=${surfaceConfig.labels}, ` +
    `runningSurfaces=${runtime.surfaces.size}, paneWindows=${runtime.windows.size}, ` +
    `retainedWindows=${runtime.retained.length}, warnings=${runtime.warnings.size}`;
}

/** A new window in the same session without -a/-b (which renumber existing tabs). */
function createSurfaceWindow(name: string): string {
  const parentPane = process.env.TMUX_PANE;
  if (!parentPane) throw new Error("Cannot find parent tmux pane (TMUX_PANE is unset)");
  const sessionId = tmux("display-message", "-p", "-t", parentPane, "#{session_id}");
  if (!/^\$\d+$/.test(sessionId)) throw new Error(`Unexpected tmux session id: ${sessionId}`);
  const title = tmuxDisplayName(name);
  const pane = tmux("new-window", "-d", "-t", `${sessionId}:`, "-n", title, "-P", "-F", "#{pane_id}");
  if (!/^%\d+$/.test(pane)) throw new Error(`Unexpected tmux new-window output: ${pane}`);
  runtime.surfaces.set(pane, { mode: "windows", name });
  try {
    tmux("set-option", "-w", "-t", pane, "automatic-rename", "off");
    tmux("set-option", "-w", "-t", pane, "allow-rename", "off");
    tmux("set-option", "-p", "-t", pane, "@pi_subagent_name", title);
  } catch (err) { warnCosmetic("could not apply window name", err); }
  return pane;
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  requireTmux();
  return surfaceConfig.mode === "windows"
    ? createSurfaceWindow(name)
    : createSurfaceSplit(name, "right", process.env.TMUX_PANE);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  requireTmux();
  const source = fromSurface ?? process.env.TMUX_PANE;
  // Standalone calls without a known parent still create a pane, but cannot
  // safely manage the entire window's UI/layout.
  const parent = process.env.TMUX_PANE;
  let state: ManagedWindow | undefined;
  if (parent && source) {
    try {
      const parentWindow = windowIdOf(parent);
      if (parentWindow === windowIdOf(source)) {
        state = runtime.windows.get(parentWindow);
        if (!state) state = snapshotWindow(parent);
        else verifyLayoutOwner(state);
      }
    } catch (err) {
      // The pane itself can still launch: diagnostics/labels are optional.
      warnCosmetic("could not inspect parent tmux window", err);
      state = undefined;
    }
  }

  const args = ["split-window", "-d"];
  args.push(direction === "left" || direction === "right" ? "-h" : "-v");
  if (direction === "left" || direction === "up") args.push("-b");
  if (source) args.push("-t", source);
  args.push("-P", "-F", "#{pane_id}");
  const pane = tmux(...args);
  if (!/^%\d+$/.test(pane)) throw new Error(`Unexpected tmux split-window output: ${pane}`);

  if (state) {
    runtime.windows.set(state.id, state);
    state.children.add(pane);
    try { state.lastKnownLayout = windowLayout(state.id); }
    catch (err) { state.automaticLayout = false; warnCosmetic("inspect split layout", err); }
    runtime.surfaces.set(pane, { mode: "panes", name, windowId: state.id });
    applyLabels(state, pane, name);
    scheduleRebalance(state);
  } else {
    runtime.surfaces.set(pane, { mode: "panes", name });
  }
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  ensurePrivateDir(dirname(scriptPath));

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writePrivateFile(scriptPath, scriptParts.join("\n") + "\n");
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
/**
 * Completed windows can be retained for inspection. Aborted or failed launches
 * always close. Retention has a hard cap; the oldest retained pane is closed.
 */
export function closeSurface(surface: string, options: { completed?: boolean } = {}): void {
  requireTmux();
  const managed = runtime.surfaces.get(surface);
  if (managed?.mode === "windows" && options.completed && surfaceConfig.keepCompletedWindows) {
    try {
      tmux("rename-window", "-t", surface, tmuxDisplayName(`done-${managed.name}`));
      runtime.retained.push(surface);
      while (runtime.retained.length > surfaceConfig.maxRetainedWindows) {
        const oldest = runtime.retained.shift()!;
        try { tmux("kill-pane", "-t", oldest); }
        catch (err) { warnCosmetic("could not close oldest completed window", err); }
      }
      runtime.surfaces.delete(surface);
      return;
    } catch (err) {
      warnCosmetic("could not retain completed window", err);
      // Fall through to normal cleanup on a closed/missing pane.
    }
  }

  // Observe manual layout edits while the child is still present. Otherwise
  // tmux's own resize caused by kill-pane looks like a user modification.
  const state = managed?.mode === "panes" && managed.windowId
    ? runtime.windows.get(managed.windowId) : undefined;
  if (state) verifyLayoutOwner(state);
  let killError: unknown;
  try { tmux("kill-pane", "-t", surface); }
  catch (err) { killError = err; }
  try {
    runtime.surfaces.delete(surface);
    if (managed?.mode === "panes" && managed.windowId) {
      const state = runtime.windows.get(managed.windowId);
      if (state) {
        state.children.delete(surface);
        // Only restore a pre-existing multi-pane layout when its original
        // panes still exist and nobody resized or replaced the layout.
        if (state.children.size === 0) {
          if (state.timer) clearTimeout(state.timer);
          if (state.automaticLayout && state.baselinePanes.size > 1) {
            try {
              const remaining = listWindowPanes(state.id);
              if (remaining.size === state.baselinePanes.size &&
                  [...remaining].every((id) => state.baselinePanes.has(id))) {
                tmux("select-layout", "-t", state.id, state.baselineLayout);
              }
            } catch (err) { warnCosmetic("restore original pane layout", err); }
          }
          restoreLabels(state);
          runtime.windows.delete(state.id);
        } else {
          try { state.lastKnownLayout = windowLayout(state.id); }
          catch (err) { state.automaticLayout = false; warnCosmetic("inspect pane removal layout", err); }
          scheduleRebalance(state);
        }
      }
    }
  } finally {
    if (killError) throw killError;
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Only a shell marker proves the child agent process actually exited. */
  source?: "shell" | "hook";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/** A sentinel is printed by the shell only after the child agent process exits. */
export function isCleanSurfaceCompletion(result: PollResult): boolean {
  return result.reason === "sentinel" && result.source === "shell" && result.exitCode === 0;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    /** Injectable asynchronous pane reader for deterministic tests. */
    readScreen?: (surface: string, lines: number) => Promise<string>;
  },
): Promise<PollResult> {
  const start = Date.now();
  let consecutiveScreenFailures = 0;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0, source: "hook" };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await (options.readScreen ?? readScreenAsync)(surface, 5);
      signal.throwIfAborted();
      consecutiveScreenFailures = 0;
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10), source: "shell" };
      }
    } catch {
      signal.throwIfAborted();
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
      if (++consecutiveScreenFailures >= 3) {
        return { reason: "error", exitCode: 1, errorMessage: `Unable to read subagent pane ${surface} after three attempts; it may have disappeared.` };
      }
    }

    signal.throwIfAborted();
    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
