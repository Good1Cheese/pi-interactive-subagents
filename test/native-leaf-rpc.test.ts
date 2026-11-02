import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("real Pi leaf child exits after its answer without loading the spawning extension", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-leaf-rpc-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the synthetic request */ }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "leaf-answer", object: "chat.completion.chunk", created: 1, model: "leaf-model", choices: [{ index: 0, delta: { role: "assistant", content: "LEAF_DONE" }, finish_reason: null }] };
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "leaf-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "synthetic-test-key", models: [{ id: "leaf-model", name: "Leaf model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  } }));
  const lifecycle = join(root, "lifecycle.json");
  const child = spawn(process.execPath, [
    resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp",
    "--extension", resolve(import.meta.dirname, "../pi-extension/subagents/subagent-done.ts"),
    "--model", "leaf-test/leaf-model", "--tools", "read",
  ], { cwd: root, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_AUTO_EXIT: "1", PI_SUBAGENT_ID: "leaf-child", PI_SUBAGENT_LIFECYCLE_FILE: lifecycle,
    PI_AUTONOMY_CHILD_ROOT_RUN_ID: "fake-root", PI_SUBAGENT_ROOT_STATE_FILE: "",
  }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => { child.kill(); rejectExit(new Error(`Leaf child did not auto-exit: ${stderr}`)); }, 10_000);
      child.once("error", error => { clearTimeout(timer); rejectExit(error); });
      child.once("close", code => { clearTimeout(timer); resolveExit(code); });
    });
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "Answer LEAF_DONE" })}\n`);
    assert.equal(await exited, 0, stderr);
    assert.equal(calls, 1);
    assert.match(stdout, /LEAF_DONE/);
    assert.equal(JSON.parse(readFileSync(lifecycle, "utf8")).state, "settled");
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
