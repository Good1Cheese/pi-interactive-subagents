import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 20_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reply(response: import("node:http").ServerResponse, index: number): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta: object, finish_reason: string | null = null) => ({
    id: `headless-${index}`, object: "chat.completion.chunk", created: 1, model: "headless-model",
    choices: [{ index: 0, delta, finish_reason }],
  });
  const records = index === 1
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: "ask-once", type: "function", function: { name: "ask_question", arguments: JSON.stringify({ question: "Which option should I use?" }) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: `HEADLESS_RESPONSE_${index}` }), chunk({}, "stop")];
  response.end(`${records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("")}data: [DONE]\n\n`);
}

test("RPC parent runs real headless children through ask, reply, and same-session resume", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "native-headless-tools-"));
  const agentDir = join(root, "agent");
  const profiles = join(agentDir, "agents");
  const sessionDir = join(agentDir, "sessions", "parent");
  mkdirSync(profiles, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const requests: any[] = [];
  const firstRequest = deferred<any>();
  const replyRequest = deferred<any>();
  const resumeRequest = deferred<any>();
  const failedRequest = deferred<any>();
  const releaseFailure = deferred<void>();
  const questionMessage = deferred<any>();
  const firstResult = deferred<any>();
  const secondResult = deferred<any>();
  const thirdResult = deferred<any>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (requests.length === 1) firstRequest.resolve(body);
    if (JSON.stringify(body.messages).includes("Choose option BLUE")) replyRequest.resolve(body);
    if (JSON.stringify(body.messages).includes("RESUMED_BLUE")) resumeRequest.resolve(body);
    if (JSON.stringify(body.messages).includes("FAIL_SYNTHETIC")) {
      failedRequest.resolve(body);
      await releaseFailure.promise;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "synthetic permanent provider failure" } }));
      return;
    }
    reply(response, requests.length);
  });
  const observedMessages: any[] = [];
  const toolMap = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const eventHandlers = new Map<string, Function[]>();
  const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT", "TMUX", "TMUX_PANE", "PATH", "PI_SUBAGENT_LIFECYCLE_FILE", "PI_SUBAGENT_SURFACE", "PI_SUBAGENT_STEERING_SOCKET", "PI_SUBAGENT_STEERING_GENERATION", "PI_AUTONOMY_CHILD_ROOT_RUN_ID", "PI_AUTONOMY_PARENT_SENTINEL", "PI_CHILD_ENV_CAPTURE"];
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const childEnvCapture = join(root, "child-env.txt");
  const privateBin = join(root, "bin");
  let serverListening = false;

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    serverListening = true;
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "headless-provider": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "synthetic-test-key", models: [{ id: "headless-model", name: "Headless model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } }));
    writeFileSync(join(profiles, "worker.md"), "---\nmodel: headless-provider/headless-model\ntools: read\nauto-exit: true\n---\nFollow the task exactly. Ask the parent for a choice, then continue with the answer.\n");

    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    mkdirSync(privateBin);
    const realPi = resolve("node_modules/.bin/pi");
    writeFileSync(join(privateBin, "pi"), `#!/bin/sh\nprintf '%s\\n' "PI_SUBAGENT_LIFECYCLE_FILE=${"${PI_SUBAGENT_LIFECYCLE_FILE-<unset>}"}" "PI_SUBAGENT_SURFACE=${"${PI_SUBAGENT_SURFACE-<unset>}"}" "PI_SUBAGENT_STEERING_SOCKET=${"${PI_SUBAGENT_STEERING_SOCKET-<unset>}"}" "PI_SUBAGENT_STEERING_GENERATION=${"${PI_SUBAGENT_STEERING_GENERATION-<unset>}"}" "PI_SUBAGENT_ID=${"${PI_SUBAGENT_ID-<unset>}"}" "PI_AUTONOMY_CHILD_ROOT_RUN_ID=${"${PI_AUTONOMY_CHILD_ROOT_RUN_ID-<unset>}"}" "PI_AUTONOMY_PARENT_SENTINEL=${"${PI_AUTONOMY_PARENT_SENTINEL-<unset>}"}" >> "$PI_CHILD_ENV_CAPTURE"\nexec ${realPi} "$@"\n`, { mode: 0o700 });
    process.env.PI_CHILD_ENV_CAPTURE = childEnvCapture;
    process.env.PI_SUBAGENT_LIFECYCLE_FILE = "parent-hostile-lifecycle";
    process.env.PI_SUBAGENT_SURFACE = "parent-hostile-surface";
    process.env.PI_SUBAGENT_STEERING_SOCKET = "parent-hostile-socket";
    process.env.PI_SUBAGENT_STEERING_GENERATION = "parent-hostile-generation";
    process.env.PI_AUTONOMY_CHILD_ROOT_RUN_ID = "parent-hostile-root-run";
    process.env.PI_AUTONOMY_PARENT_SENTINEL = "preserve-parent-config";
    process.env.PATH = `${privateBin}:${resolve("node_modules/.bin")}:${process.env.PATH ?? ""}`;
    for (const key of ["PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT", "TMUX", "TMUX_PANE"]) delete process.env[key];

    const events = {
      on(name: string, handler: Function) { eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]); },
      emit(name: string, payload: any) { for (const handler of eventHandlers.get(name) ?? []) handler(payload); },
    };
    const pi = {
      events,
      registerTool(tool: any) { toolMap.set(tool.name, tool); },
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
      getAllTools() { return []; },
      sendMessage(message: any) {
        observedMessages.push(message);
        if (message.customType === "subagent_question") questionMessage.resolve(message);
        if (message.customType === "subagent_result" && message.details?.name === "headless-worker") {
          const resultCount = observedMessages.filter((item) => item.customType === "subagent_result" && item.details?.name === "headless-worker").length;
          if (resultCount === 1) firstResult.resolve(message);
          else if (resultCount === 2) secondResult.resolve(message);
        }
        if (message.customType === "subagent_result" && message.details?.name === "headless-failure") thirdResult.resolve(message);
      }
    };
    const { default: subagentsExtension } = await import("../pi-extension/subagents/index.ts");
    subagentsExtension(pi as any);
    const parentSessionFile = join(sessionDir, "parent.jsonl");
    writeFileSync(parentSessionFile, JSON.stringify({ type: "session", version: 3, id: "headless-parent-session", timestamp: new Date().toISOString(), cwd: root }) + "\n");
    const ctx = {
      cwd: root,
      mode: "rpc",
      model: { provider: "headless-provider", id: "headless-model" },
      sessionManager: {
        getSessionId: () => "headless-parent-session",
        getSessionFile: () => parentSessionFile,
        getSessionDir: () => sessionDir,
      },
      ui: { setWidget() {}, setStatus() {}, notify() {} },
    };
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    const spawned = await toolMap.get("subagent").execute("spawn", {
      agent: "worker", name: "headless-worker", task: "Ask the parent which option to use. After its answer, report that answer and finish.",
    }, undefined, undefined, ctx);
    assert.equal(spawned.details?.status, "started", JSON.stringify(spawned));
    const initialBody = await within(firstRequest.promise, "RPC child did not make its first provider request without tmux");
    assert.equal(initialBody.model, "headless-model");
    assert.ok(initialBody.tools?.some((tool: any) => tool.function?.name === "ask_question"), "the real child request has the registered ask_question tool");

    const question = await within(questionMessage.promise, "child ask_question was not surfaced to the parent");
    assert.match(question.content, /Which option should I use\?/);
    const steered = await toolMap.get("subagent_message").execute("reply", {
      name: "headless-worker", message: "Choose option BLUE. Include BLUE in your final answer.",
    }, undefined, undefined, ctx);
    assert.equal(steered.details?.status, "steered", JSON.stringify(steered));
    const afterReply = await within(replyRequest.promise, "reply did not reach a subsequent real provider request");
    assert.ok(JSON.stringify(afterReply.messages).includes("Choose option BLUE"));

    const finished = await within(firstResult.promise, "replied child did not settle");
    assert.equal(finished.details.exitCode, 0);
    assert.match(finished.content, /HEADLESS_RESPONSE_3/);
    const childSession = spawned.details.sessionFile;
    const originalSessionId = JSON.parse(readFileSync(childSession, "utf8").split("\n")[0]).id;
    const resumed = await toolMap.get("subagent_message").execute("resume", {
      name: "headless-worker", message: "For this new generation, report RESUMED_BLUE and then finish.",
    }, undefined, undefined, ctx);
    assert.equal(resumed.details?.status, "started", JSON.stringify(resumed));
    const resumeBody = await within(resumeRequest.promise, "finished child did not resume as another real RPC generation");
    assert.ok(JSON.stringify(resumeBody.messages).includes("RESUMED_BLUE"));
    const askCalls = readFileSync(childSession, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message" && entry.message?.role === "assistant" && entry.message?.content?.some((part: any) => part.type === "toolCall" && part.name === "ask_question"));
    assert.equal(askCalls.length, 1, "the original ask tool call is not replayed into the session");
    assert.equal(JSON.parse(readFileSync(childSession, "utf8").split("\n")[0]).id, originalSessionId, "resume keeps the same session");

    const resumedResult = await within(secondResult.promise, "resumed child did not settle");
    assert.equal(resumedResult.details.exitCode, 0);
    assert.match(resumedResult.content, /HEADLESS_RESPONSE_4/);

    const failedSpawn = await toolMap.get("subagent").execute("spawn", {
      agent: "worker", name: "headless-failure", task: "FAIL_SYNTHETIC",
    }, undefined, undefined, ctx);
    assert.equal(failedSpawn.details?.status, "started", JSON.stringify(failedSpawn));
    await within(failedRequest.promise, "third generation did not reach its held provider request");
    await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
    eventHandlers.clear();
    handlers.clear();
    toolMap.clear();
    const { default: reloadedExtension } = await import(`../pi-extension/subagents/index.ts?headless-reload=${Date.now()}`);
    reloadedExtension(pi as any);
    handlers.get("session_start")?.({ reason: "reload" }, ctx);
    releaseFailure.resolve();

    const failed = await within(thirdResult.promise, "reloaded parent did not report the provider failure");
    assert.notEqual(failed.details.exitCode, 0, JSON.stringify(failed));
    assert.match(failed.details.errorMessage, /synthetic permanent provider failure/i);
    assert.doesNotMatch(failed.content, /auto-retry exhausted/i);

    const captured = readFileSync(childEnvCapture, "utf8").trim().split("\n");
    const keys = ["PI_SUBAGENT_LIFECYCLE_FILE", "PI_SUBAGENT_SURFACE", "PI_SUBAGENT_STEERING_SOCKET", "PI_SUBAGENT_STEERING_GENERATION", "PI_SUBAGENT_ID", "PI_AUTONOMY_CHILD_ROOT_RUN_ID", "PI_AUTONOMY_PARENT_SENTINEL"];
    assert.equal(captured.length, keys.length * 3, "the wrapper observed all three real Pi generations");
    const generations = Array.from({ length: 3 }, (_, index) => Object.fromEntries(captured.slice(index * keys.length, (index + 1) * keys.length).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    })));
    for (const env of generations) {
      assert.equal(env.PI_SUBAGENT_LIFECYCLE_FILE, "<unset>", "RPC generations do not inherit a stale parent lifecycle file");
      assert.equal(env.PI_SUBAGENT_SURFACE, "<unset>", "RPC generations do not inherit a stale parent surface");
      assert.notEqual(env.PI_SUBAGENT_STEERING_SOCKET, "parent-hostile-socket");
      assert.notEqual(env.PI_SUBAGENT_STEERING_GENERATION, "parent-hostile-generation");
      assert.equal(env.PI_AUTONOMY_CHILD_ROOT_RUN_ID, "<unset>", "parent child-run scope is not inherited");
      assert.equal(env.PI_AUTONOMY_PARENT_SENTINEL, "preserve-parent-config", "non-child autonomy configuration is preserved");
    }
    assert.equal(new Set(generations.map((env) => env.PI_SUBAGENT_ID)).size, 3, "each real child generation receives a fresh identity");
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "shutdown" }, undefined);
    server.closeAllConnections();
    if (serverListening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
