import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "../pi-extension/subagents/tools/dcg-guard.ts";
import { pollForExit } from "../pi-extension/subagents/tmux.ts";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";
import { ensurePrivateDir, writePrivateFile } from "../pi-extension/subagents/private-files.ts";
import subagentDone from "../pi-extension/subagents/subagent-done.ts";

test("dcg permits, denies, and fails closed on technical errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-dcg-"));
  const previous = process.env.PATH;
  const dcg = join(dir, "dcg");
  try {
    process.env.PATH = dir;
    assert.equal(checkCommand("anything").missing, true);
    writeFileSync(dcg, '#!/nonexistent/interpreter\n', { mode: 0o700 });
    assert.equal(checkCommand("anything").block, true);
    writeFileSync(dcg, '#!/bin/sh\nprintf \'{"decision":"allow"}\'\n', { mode: 0o700 });
    assert.equal(checkCommand("echo ok").block, undefined);
    writeFileSync(dcg, '#!/bin/sh\nprintf \'{"decision":"deny"}\'\nexit 1\n', { mode: 0o700 });
    assert.equal(checkCommand("bad").block, true);
    writeFileSync(dcg, '#!/bin/sh\nprintf invalid\n', { mode: 0o700 });
    assert.equal(checkCommand("anything").block, true);
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sensitive seeded sessions and questions tighten existing files under umask 022", async () => {
  const oldMask = process.umask(0o022);
  const oldSession = process.env.PI_SUBAGENT_SESSION;
  const oldActivity = process.env.PI_SUBAGENT_ACTIVITY_FILE;
  const oldId = process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  delete process.env.PI_SUBAGENT_ID;
  const dir = mkdtempSync(join(tmpdir(), "subagent-private-"));
  try {
    const privateDir = join(dir, "artifacts"); mkdirSync(privateDir, { mode: 0o755 }); chmodSync(privateDir, 0o755);
    ensurePrivateDir(privateDir);
    assert.equal(statSync(privateDir).mode & 0o777, 0o700);
    const parent = join(dir, "parent.jsonl");
    writeFileSync(parent, '{"type":"session","id":"parent"}\n{"type":"message","message":{"role":"assistant"}}\n');
    const child = join(dir, "child.jsonl"); writeFileSync(child, "old", { mode: 0o644 }); chmodSync(child, 0o644);
    seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent, childSessionFile: child, childCwd: dir });
    assert.equal(statSync(child).mode & 0o777, 0o600);
    const artifact = join(privateDir, "task.md"); writeFileSync(artifact, "old"); chmodSync(artifact, 0o644);
    writePrivateFile(artifact, "secret"); assert.equal(statSync(artifact).mode & 0o777, 0o600);
    writeFileSync(`${child}.ask`, "old"); chmodSync(`${child}.ask`, 0o644);
    process.env.PI_SUBAGENT_SESSION = child;
    const tools: any[] = [];
    subagentDone({ on() {}, registerShortcut() {}, registerTool(tool: any) { tools.push(tool); } } as any);
    await tools.find((tool) => tool.name === "ask_question").execute("id", { question: "secret?" });
    assert.equal(statSync(`${child}.ask`).mode & 0o777, 0o600);
  } finally {
    process.umask(oldMask);
    if (oldSession === undefined) delete process.env.PI_SUBAGENT_SESSION; else process.env.PI_SUBAGENT_SESSION = oldSession;
    if (oldActivity === undefined) delete process.env.PI_SUBAGENT_ACTIVITY_FILE; else process.env.PI_SUBAGENT_ACTIVITY_FILE = oldActivity;
    if (oldId === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = oldId;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing pane terminates watcher after bounded retries", async () => {
  const previous = process.env.TMUX;
  process.env.TMUX = "test";
  try {
    const result = await pollForExit("%99999999", new AbortController().signal, { interval: 1 });
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage!, /three attempts/);
  } finally {
    if (previous === undefined) delete process.env.TMUX; else process.env.TMUX = previous;
  }
});
