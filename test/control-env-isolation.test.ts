import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("legacy test leaves an inherited lifecycle sentinel untouched", () => {
  const directory = mkdtempSync(join(tmpdir(), "control-env-isolation-"));
  try {
    const lifecycleFile = join(directory, "lifecycle.json");
    const sentinel = '{"childId":"sentinel","sequence":41,"state":"sentinel"}\n';
    writeFileSync(lifecycleFile, sentinel);
    const env = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_AUTONOMY_"))
        .map((key) => [key, "synthetic-controller-value"]),
    );
    Object.assign(env, {
      PI_SUBAGENT_ID: "synthetic-child",
      PI_SUBAGENT_LIFECYCLE_FILE: lifecycleFile,
      PI_SUBAGENT_ACTIVITY_FILE: join(directory, "activity.jsonl"),
      PI_SUBAGENT_ROOT_STATE_FILE: join(directory, "root-state.json"),
      PI_SUBAGENT_SESSION: join(directory, "session.jsonl"),
      HOME: join(directory, "home"),
      PI_CODING_AGENT_DIR: join(directory, "pi"),
    });
    const result = spawnSync(process.execPath, [
      "--test",
      "--test-name-pattern=exits \\(does not park\\) when the reply arrives mid-run via input",
      resolve("test/test.ts"),
    ], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(lifecycleFile, "utf8"), sentinel);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
