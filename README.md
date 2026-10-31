# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Auto-generated names are suffixed (`scout`, `scout-2`, …); duplicate explicit names and control characters are rejected |
| `model` | string | profile model, otherwise parent's current model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original loadout.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | inherited | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | inherited | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | inherited | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Profile model; otherwise inherit the parent's current provider/model |
| `thinking` | string | `minimal`, `low`, `medium`, or `high` |
| `tools` | string or string array | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string or string array | Comma-separated or YAML array of agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string or string array | Comma-separated or YAML array of names discovered in default Pi skill directories. Their instructions are included in the same initial task; unknown names fail the launch. Explicit profile selection reads project skills before the child Pi trust prompt, so use only trusted profiles/projects |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | Only Pi is supported; `claude` profiles are refused |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **allowlist-only**. Every child uses `--no-extensions` and `--tools`, loads only tool-backing extensions and explicitly configured child extensions, and rejects calls outside the exact tool list even if an extension registers more tools. If `tools` is omitted the default is `read,write,edit,bash`, plus the `ask_question` control tool. Spawning tools are granted only by `subagent_agents`, never by listing them in `tools`. Explicit null, empty, malformed or unsupported security-sensitive values are rejected rather than falling back to defaults. The resolved paths, tool list and spawn grants are snapshotted and validated on resume; older or invalid snapshots cannot be resumed. Extensions execute trusted code with the user's permissions, so this is not an OS sandbox.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global. Only named tools are allowed, even if their backing extension also registers other tools.

The child loads `dcg-guard.ts` last on launch and resume, after configured input-transforming extensions. If `dcg` is installed, each `bash`/`safe_bash` tool command is checked using `dcg test --stdin --robot --dialect posix`; denial, error, invalid output or timeout blocks it. If absent, a warning is emitted and commands proceed unchecked. This is a command policy, **not** an OS sandbox: arbitrary code, other tools, trusted extensions (including late-registered handlers) and user terminal input can bypass it. Install and configure dcg separately; no global hooks or config are modified.

## Role folders

`cwd` starts a sub-agent in a directory with its own context and default skill discovery. Extensions still require the explicit child allowlist:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true },
  "childExtensions": ["/absolute/path/to/trusted-provider-or-security-extension.ts"]
}
```

`childExtensions` is optional and defaults to `[]`; agent frontmatter does not support an `extensions` field. Use absolute existing file or directory paths; malformed or missing paths fail launch. List every trusted provider/security extension needed by children explicitly: parent extensions are not inherited. Changes affect new launches only; resume replays its original snapshot and fails if a snapshotted extension is missing. A provider extension is necessary when the inherited model is supplied by one.

Task and system-prompt artifacts contain potentially sensitive instructions and are retained with the parent session. Extension-owned artifact directories are owner-only and files are tightened to owner-only when written, including existing files; shared session directories are not changed. Existing artifacts not rewritten are not retroactively changed. Reload transfers live child watchers and cancels launches still starting; switching/forking the parent session is refused while children run or start.

If a legacy or missing loadout prevents resume, start a fresh subagent with a reviewed profile and explicitly supply any necessary context from the old session. Do not invent or copy permissions into the old snapshot: the original tool and extension grants cannot be inferred safely.

## Requirements

- [Earendil Works Pi](https://github.com/earendil-works/pi) 1.4 or newer
- [tmux](https://github.com/tmux/tmux)
- Optional: [dcg](https://github.com/Dicklesworthstone/destructive_command_guard)

A clean `npm ci` from this repository's lockfile overrides `undici` to 8.12.3 (requires Node >=22.19). An existing mixed npm/pnpm `node_modules` may still resolve a different version: check `npm ls undici` and resolve it from the actual Pi package, or use a clean install. npm overrides are local to the installing root project; they do **not** patch a separately installed Pi host or a consuming project's dependency tree. Keep the host Pi and its dependencies updated independently.

As of 2026-10-31, `npm audit` reports two moderate entries for one underlying issue, [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), in Pi's `minimatch` 10.2.6 dependency. It can cause denial of service through glob-pattern amplification. The local lockfile does not override it to the fixed major version 11, which is outside Pi's pinned dependency and has not been validated for compatibility. The independently installed Pi host has its own dependency tree and must be assessed separately.

```bash
tmux new -A -s pi 'pi'
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
