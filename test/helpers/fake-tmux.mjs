#!/usr/bin/env node
// Stateful fake for unit testing tmux's argv and our ownership logic.
// NOT a substitute for the real tmux integration suite.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const filename = process.env.FAKE_TMUX_STATE;
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(filename, "utf8"));
appendFileSync(process.env.FAKE_TMUX_TRACE, JSON.stringify(args) + "\n");
const windows = state.windows;
const findPane = (pane) => Object.entries(windows).find(([, w]) => w.panes.includes(pane));
const resolveWindow = (target) => {
  if (windows[target]) return target;
  if (target?.startsWith("%")) return findPane(target)?.[0];
  throw new Error(`Unknown tmux target: ${target}`);
};
const value = (flag) => args[args.indexOf(flag) + 1];
const target = args.includes("-t") ? value("-t") : "%100";
const kind = args[0];
let output = "";
const touch = (id, suffix = "change") => { windows[id].layout = `${suffix}-${++state.seq}`; };
try {
  if (kind === "display-message") {
    const fmt = args.at(-1);
    const id = resolveWindow(target);
    output = fmt === "#{pane_id}" ? (findPane(target)?.[1].panes.includes(target) ? target : "")
      : fmt === "#{window_width}x#{window_height}" ? `${state.width ?? 170}x${state.height ?? 45}`
      : fmt === "#{window_id}" ? id
      : fmt === "#{session_id}" ? "$3"
      : fmt === "#{window_layout}" ? windows[id].layout
      : fmt === "#{window_index}" ? String(windows[id].index)
      : fmt === "#{window_zoomed_flag}" ? (windows[id].zoomed ? "1" : "0")
      : "";
  } else if (kind === "list-panes") {
    output = args.includes("-a")
      ? Object.values(windows).flatMap(w => w.panes).join("\n")
      : windows[resolveWindow(target)].panes.join("\n");
  } else if (kind === "show-options") {
    const pane = args.includes("-p");
    const record = pane ? state.paneOptions[target] ?? {} : windows[resolveWindow(target)].options;
    if (args.includes("-v")) output = record[args.at(-1)] ?? "";
    else output = Object.entries(record).map(([key, val]) => `${key} ${val}`).join("\n");
  } else if (kind === "set-option") {
    if (state.failSetOption) throw new Error("Simulated tmux set-option failure");
    const pane = args.includes("-p");
    const record = pane
      ? (state.paneOptions[target] ??= {})
      : windows[resolveWindow(target)].options;
    const key = args.at(args.includes("-u") ? -1 : -2);
    if (args.includes("-u")) delete record[key];
    else record[key] = args.at(-1);
  } else if (kind === "split-window") {
    const id = resolveWindow(target);
    const pane = `%${state.nextPane++}`;
    windows[id].panes.push(pane);
    touch(id, "split");
    output = pane;
  } else if (kind === "new-window") {
    if (args.includes("-a") || args.includes("-b")) throw new Error("window indexes would shift");
    if (target !== "$3:") throw new Error(`wrong session selector: ${target}`);
    const used = new Set(Object.values(windows).map(w => w.index));
    let idx = 1;
    while (used.has(idx)) idx++;
    const pane = `%${state.nextPane++}`;
    const id = `@${state.nextWindow++}`;
    windows[id] = { index: idx, title: value("-n"), options: {}, panes: [pane], layout: "one" };
    output = pane;
  } else if (kind === "select-layout") {
    if (state.failCustomLayout && /^[a-f\d]{4},/.test(args.at(-1) ?? "")) {
      throw new Error("Custom layout unsupported by tmux");
    }
    const id = resolveWindow(target);
    touch(id, args.at(-1));
  } else if (kind === "kill-pane") {
    if (state.failKillPaneOnce > 0) {
      state.failKillPaneOnce--;
      writeFileSync(filename, JSON.stringify(state));
      throw new Error("Simulated transient kill-pane failure");
    }
    const match = findPane(target);
    if (!match) throw new Error("no such pane");
    const [id, w] = match;
    w.panes = w.panes.filter(p => p !== target);
    delete state.paneOptions[target];
    if (w.panes.length === 0) delete windows[id];
    else touch(id, "kill");
  } else if (kind === "rename-window") {
    windows[resolveWindow(target)].title = args.at(-1);
  } else if (kind === "send-keys" || kind === "capture-pane") {
    // Calls outside this test's assertions.
  } else {
    throw new Error(`Unsupported fake tmux call: ${args.join(" ")}`);
  }
  writeFileSync(filename, JSON.stringify(state));
  process.stdout.write(output ? `${output}\n` : "");
} catch (error) {
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
}
