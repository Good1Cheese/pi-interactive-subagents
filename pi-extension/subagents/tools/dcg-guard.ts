import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

function dcgOnPath(): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => existsSync(join(dir || ".", "dcg")));
}

/** Optional command policy, not an OS sandbox. */
export function checkCommand(command: string): { block?: boolean; reason?: string; missing?: boolean } {
  const result = spawnSync("dcg", ["test", "--stdin", "--robot", "--dialect", "posix"], {
    input: command, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && !dcgOnPath()) return { missing: true };
  if (result.error || result.status === null) return { block: true, reason: `dcg failed or timed out: ${result.error?.message ?? result.signal}` };
  if (result.status !== 0) return { block: true, reason: `dcg denied or could not evaluate command: ${result.stdout || result.stderr || `exit ${result.status}`}` };
  try {
    const data = JSON.parse(result.stdout);
    if (data.decision !== "allow") return { block: true, reason: `dcg did not explicitly allow command: ${result.stdout}` };
  } catch {
    return { block: true, reason: "dcg returned invalid JSON" };
  }
  return {};
}

export default function (pi: ExtensionAPI) {
  const allowlist = new Set((process.env.PI_SUBAGENT_TOOL_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  let warned = false;
  const warn = (notify?: (message: string, type: "warning") => void) => {
    if (!warned) {
      const message = "dcg not installed; subagent shell commands are not checked by dcg.";
      if (notify) notify(message, "warning"); else console.warn(`[subagents] WARNING: ${message}`);
      warned = true;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    const probe = spawnSync("dcg", ["--version"], { encoding: "utf8", timeout: 5000 });
    if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && !dcgOnPath()) warn(ctx.ui.notify);
  });
  pi.on("before_agent_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => allowlist.has(name)));
  });
  pi.on("tool_call", (event) => {
    if (!allowlist.has(event.toolName)) return { block: true, reason: `Tool ${event.toolName} is not in the child allowlist` };
    if (event.toolName !== "bash" && event.toolName !== "safe_bash") return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return { block: true, reason: "Missing shell command" };
    const result = checkCommand(command);
    if (result.missing) warn();
    if (result.block) return { block: true, reason: result.reason };
  });
}
