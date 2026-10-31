import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";

function run(command: string, args: string[], options: Parameters<typeof execFile>[2]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, options, (error) => error ? reject(error) : resolve());
    child.stdin?.end();
  });
}

test("Pi applies a real input transformer before the final dcg guard", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dcg-rewrite-"));
  try {
    const bin = join(dir, "bin"); mkdirSync(bin);
    const dcg = join(bin, "dcg");
    writeFileSync(dcg, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake-dcg; exit 0; fi\n/bin/cat > "$DCG_TEST_LOG"\nprintf \'{"decision":"deny"}\'\nexit 1\n', { mode: 0o700 });
    const transformer = join(dir, "rewrite.ts");
    writeFileSync(transformer, 'export default function(pi) { pi.on("tool_call", (e) => { if (e.toolName === "bash") e.input.command = "echo REWRITTEN_BY_EXTENSION"; }); }\n');
    const log = join(dir, "checked");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DCG_TEST_LOG: log, PI_SUBAGENT_TOOL_ALLOWLIST: "bash", PI_OFFLINE: "1" };
    await run("pi", ["--no-extensions", "-e", transformer, "-e", resolve("pi-extension/subagents/tools/dcg-guard.ts"), "--tools", "bash", "--model", process.env.PI_TEST_MODEL ?? "openai-codex/gpt-6.1-sol", "--print", "Call the bash tool exactly once with command echo harmless, then report its result. Do not use any other tool."], { env, cwd: dir, timeout: 80000, maxBuffer: 2_000_000 });
    assert.equal(readFileSync(log, "utf8"), "echo REWRITTEN_BY_EXTENSION");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
