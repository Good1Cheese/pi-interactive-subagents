import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TmuxSurfaceConfig } from "./tmux.ts";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_STALLED_AFTER_MS = 60_000;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

/** Kept outside Pi's managed Git checkout, which `pi update` may clean. */
function userConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-interactive-subagents", "config.json");
}

export type NameFallback = "random" | "numbered";

export const DEFAULT_TMUX_CONFIG: TmuxSurfaceConfig = {
  mode: "panes",
  layout: "balanced",
  mainPaneWeight: 1.25,
  labels: "bottom",
  keepCompletedWindows: false,
  maxRetainedWindows: 4,
};

export type SubagentStatusKind = "starting" | "active" | "waiting" | "stalled" | "running";
export type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";
export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
  tmux: TmuxSurfaceConfig;
  names: { fallback: NameFallback };
}

export type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: StatusActivityPhase;
      active?: boolean;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      latestEvent?: string;
      activityLabel?: string;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  localOverrideAtMs: number | null;
  localOverrideSequence: number | null;
  activeNow: boolean;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  phase: StatusActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: string | null;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedInt(value: unknown, fallback: number, source: string, fieldName: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10) {
    invalidStatusConfig(source, `${fieldName} must be an integer from 1 to 10`);
  }
  return value as number;
}

function mainWeight(value: unknown, source: string): number {
  if (value === undefined) return DEFAULT_TMUX_CONFIG.mainPaneWeight;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 2) {
    invalidStatusConfig(source, "tmux.mainPaneWeight must be a number between 1 and 2");
  }
  return value;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function boundStatusLine(line: string): string {
  return truncateText(line.replace(/\s+/g, " ").trim(), MAX_STATUS_LINE_LENGTH);
}

function snapshotProblemLabel(snapshotState: StatusSnapshotState): string | null {
  if (snapshotState === "wrong-id") return "wrong activity id";
  return null;
}

function activityLabel(snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope;
}

const TMUX_MODES = ["panes", "windows"] as const;
const TMUX_LAYOUTS = ["balanced", "tiled", "even-horizontal", "even-vertical", "main-vertical", "main-horizontal"] as const;
const LABEL_POSITIONS = ["bottom", "top", "off"] as const;
const NAME_FALLBACKS = ["random", "numbered"] as const;

function configChoice<T extends string>(
  value: unknown, allowed: readonly T[], fallback: T, source: string, key: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return invalidStatusConfig(source, `${key} must be one of: ${allowed.join(", ")}`);
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  rejectUnsupportedKeys(config, ["status", "tmux", "names", "childExtensions"], source, "root");
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  const tmux = config.tmux === undefined ? {} : requireObject(config.tmux, source, "tmux");
  rejectUnsupportedKeys(tmux, ["mode", "layout", "mainPaneWeight", "labels", "keepCompletedWindows", "maxRetainedWindows"], source, "tmux");
  const names = config.names === undefined ? {} : requireObject(config.names, source, "names");
  rejectUnsupportedKeys(names, ["fallback"], source, "names");

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
    tmux: {
      mode: configChoice(tmux.mode, TMUX_MODES, DEFAULT_TMUX_CONFIG.mode, source, "tmux.mode"),
      layout: configChoice(tmux.layout, TMUX_LAYOUTS, DEFAULT_TMUX_CONFIG.layout, source, "tmux.layout"),
      mainPaneWeight: mainWeight(tmux.mainPaneWeight, source),
      labels: configChoice(tmux.labels, LABEL_POSITIONS, DEFAULT_TMUX_CONFIG.labels, source, "tmux.labels"),
      keepCompletedWindows: tmux.keepCompletedWindows === undefined ? false : requireBoolean(tmux.keepCompletedWindows, source, "tmux.keepCompletedWindows"),
      maxRetainedWindows: boundedInt(tmux.maxRetainedWindows, 4, source, "tmux.maxRetainedWindows"),
    },
    names: { fallback: configChoice(names.fallback, NAME_FALLBACKS, "random", source, "names.fallback") },
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${path}: ${detail}`);
  }
  return requireObject(raw, path, "root");
}

function mergeUiSection(
  legacy: Record<string, unknown>, user: Record<string, unknown>, section: string,
  path: string,
): Record<string, unknown> | undefined {
  if (user[section] === undefined) return legacy[section] as Record<string, unknown> | undefined;
  const current = legacy[section] === undefined ? {} : requireObject(legacy[section], path, section);
  return { ...current, ...requireObject(user[section], path, section) };
}

/**
 * Prefer a stable XDG UI config without silently dropping package-local
 * childExtensions. A conflicting explicit allowlist is a migration error.
 * Pass `userPath` in tests to make them independent from $HOME.
 */
export function loadSubagentRootConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
  userPath = configPath === DEFAULT_STATUS_CONFIG_PATH && examplePath === STATUS_CONFIG_EXAMPLE_PATH
    ? userConfigPath() : undefined,
): Record<string, unknown> {
  const baselinePath = existsSync(configPath) ? configPath : examplePath;
  if (!existsSync(baselinePath)) {
    throw new Error(`Missing subagent status config. Expected ${configPath} or ${examplePath}.`);
  }
  const baseline = readJsonObject(baselinePath);
  if (!userPath || !existsSync(userPath)) return baseline;
  const user = readJsonObject(userPath);
  rejectUnsupportedKeys(user, ["status", "tmux", "names", "childExtensions"], userPath, "root");

  const oldExtensions = baseline.childExtensions;
  const newExtensions = user.childExtensions;
  if (Array.isArray(oldExtensions) && oldExtensions.length > 0 && newExtensions !== undefined &&
    JSON.stringify(oldExtensions) !== JSON.stringify(newExtensions)) {
    invalidStatusConfig(userPath, `childExtensions conflicts with the nonempty allowlist in ${baselinePath}. ` +
      `Copy the original list unchanged, or migrate it explicitly and remove the package-local config first.`);
  }
  return {
    ...baseline,
    ...user,
    status: mergeUiSection(baseline, user, "status", userPath),
    tmux: mergeUiSection(baseline, user, "tmux", userPath),
    names: mergeUiSection(baseline, user, "names", userPath),
    // Preserve absence: parseConfiguredExtensions treats an explicitly-present
    // non-array as invalid. Adding an own key with value undefined would
    // incorrectly break launches whenever both config files omit the allowlist.
    ...(newExtensions !== undefined || oldExtensions !== undefined
      ? { childExtensions: newExtensions === undefined ? oldExtensions : newExtensions }
      : {}),
  };
}

export function loadStatusConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
  userPath?: string,
): StatusConfig {
  const merged = loadSubagentRootConfig(configPath, examplePath, userPath);
  return parseStatusConfig(merged, userPath && existsSync(userPath) ? userPath : configPath);
}

export function formatElapsedDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;

  return `${minutes}m`;
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: params.source === "claude" ? "unseen" : "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: initialKind,
  };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  if (observation.snapshot !== "present") {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    };
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  const lastActivityAtMs = state.lastActivityAtMs;
  const lastActivitySequence = state.lastActivitySequence;
  const olderThanLastActivity = lastActivityAtMs != null && (
    updatedAt < lastActivityAtMs ||
    (updatedAt === lastActivityAtMs && lastActivitySequence != null && sequence < lastActivitySequence)
  );
  if (olderThanLastActivity) return state;

  const blockedByLocalOverride = state.localOverrideAtMs != null && (
    updatedAt < state.localOverrideAtMs ||
    (updatedAt === state.localOverrideAtMs && state.localOverrideSequence != null && sequence <= state.localOverrideSequence)
  );
  if (blockedByLocalOverride) return state;

  const phase = observation.phase;
  const activeNow = phase === "active" || observation.active === true;
  const activeSinceMs = activeNow
    ? observation.activeSince ?? state.activeSinceMs ?? updatedAt
    : null;
  const waitingSinceMs = phase === "waiting"
    ? observation.waitingSince ?? state.waitingSinceMs ?? updatedAt
    : null;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeNow,
    activeSinceMs,
    activeScope: activeNow ? observation.activeScope ?? null : null,
    waitingSinceMs,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  };
}

export function forceStatusAfterInterrupt(state: SubagentStatusState, now: number): SubagentStatusState {
  if (state.source === "claude") return state;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    phase: "waiting",
    latestEvent: "interrupt_requested",
    activityLabel: "interrupted",
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: "waiting",
  };
}

function classifyProblemState(state: SubagentStatusState, now: number): Pick<StatusSnapshot, "kind" | "statusLabel"> {
  const problemLabel = snapshotProblemLabel(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    return elapsedMs >= SNAPSHOT_STALLED_AFTER_MS
      ? { kind: "stalled", statusLabel: problemLabel }
      : { kind: "starting", statusLabel: null };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) return { kind: "stalled", statusLabel: problemLabel };

  const lastHealthyKind = state.activeNow
    ? "active"
    : state.waitingSinceMs != null || state.phase === "done"
      ? "waiting"
      : state.currentKind === "stalled"
        ? "starting"
        : state.currentKind;
  return { kind: lastHealthyKind, statusLabel: problemLabel };
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      waitingDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
    };
  }

  let kind: SubagentStatusKind;
  let statusLabel: string | null = null;

  if (state.snapshotState === "present") {
    if (state.phase === "active" || state.activeNow) {
      kind = "active";
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      kind = elapsedSinceObservationMs >= SNAPSHOT_STALLED_AFTER_MS ? "stalled" : "starting";
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
  }

  const activeDurationText = state.activeSinceMs == null
    ? null
    : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText = state.waitingSinceMs == null
    ? null
    : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText = state.snapshotProblemSinceMs == null
    ? null
    : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" && (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  };
}

function formatActiveDetail(snapshot: StatusSnapshot): string {
  const label = activityLabel(snapshot);
  if (!label) return "active";
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return `active (${label}${duration})`;
}

function formatWaitingDetail(snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `waiting${duration}`;
}

function formatStalledDetail(snapshot: StatusSnapshot): string {
  const detail = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `stalled${duration}${detail}`;
}

export function formatStatusLine(name: string, snapshot: StatusSnapshot): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const label = snapshot.statusLabel ? ` (${snapshot.statusLabel})` : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, starting${label}.`);
  }

  if (snapshot.kind === "running") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}.`);
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatActiveDetail(snapshot)}.`);
  }

  if (snapshot.kind === "waiting") {
    const problem = snapshot.statusLabel && snapshot.statusLabel !== "done"
      ? ` (${snapshot.statusLabel})`
      : snapshot.statusLabel === "done"
        ? " (done)"
        : "";
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatWaitingDetail(snapshot)}${problem}.`);
  }

  return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, ${formatStalledDetail(snapshot)}.`);
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail = snapshot.kind === "waiting" ? formatWaitingDetail(snapshot) : formatActiveDetail(snapshot);
    return boundStatusLine(`${boundedName} running ${snapshot.elapsedText}, recovered; ${detail}.`);
  }

  return formatStatusLine(boundedName, snapshot);
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}

export function formatStatusAggregate(lines: string[], lineLimit: number): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) bulletLines.push(`• +${overflow} more running.`);
  return `Subagent status:\n${bulletLines.join("\n")}`;
}
