import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function deferred<T = void>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function tmux(socket: string, ...args: string[]): string {
  return execFileSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      TERM: process.env.TERM ?? "xterm-256color",
      LANG: process.env.LANG ?? "C.UTF-8",
    },
  }).trim();
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("public subagent_message reaches the next real Pi provider context", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "native-steering-context-"));
  const agentDir = join(root, "agent");
  const agentProfiles = join(agentDir, "agents");
  const sessionDir = join(agentDir, "sessions", "parent");
  mkdirSync(agentProfiles, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const marker = `STEER_CONTEXT_${process.pid}_${Date.now()}`;
  const socket = `pi-steer-${process.pid}-${Date.now()}`;
  const providerOne = deferred<{ body: any; release: () => void }>();
  const secondRequest = deferred<any>();
  const firstResponseGate = deferred();
  const requests: any[] = [];
  let tmuxStarted = false;
  let childSurface: string | undefined;
  let rootPane: string | undefined;
  const handlers = new Map<string, Function>();
  const savedEnv = new Map(["HOME", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ALLOWED", "TMUX", "TMUX_PANE", "PATH"].map((key) => [key, process.env[key]]));

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (requests.length === 1) {
      providerOne.resolve({ body, release: () => firstResponseGate.resolve() });
      await firstResponseGate.promise;
    } else if (requests.length === 2) {
      secondRequest.resolve(body);
    }
    const index = requests.length;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: `FIXTURE_RESPONSE_${index}` }, finish_reason: null }] };
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "fixture-provider": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "synthetic-test-key", models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    } }));
    writeFileSync(join(agentProfiles, "fixture-agent.md"), "---\nmodel: fixture-provider/fixture-model\ntools: read\n---\nSynthetic provider steering fixture.\n");

    const oldPath = process.env.PATH ?? "";
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_ALLOWED;
    process.env.PATH = `${resolve("node_modules/.bin")}:${oldPath}`;

    // This session/socket exists only for this test. The extension uses the
    // TMUX metadata to target this server; no global tmux session is touched.
    tmux(socket, "new-session", "-d", "-s", "fixture", "node", "-e", "process.stdin.resume()");
    tmuxStarted = true;
    const mux = tmux(socket, "display-message", "-p", "-t", "fixture:0.0", "#{socket_path},#{pid},#{pane_index},#{pane_id}");
    const [socketPath, serverPid, paneIndex, paneId] = mux.split(",");
    rootPane = paneId;
    process.env.TMUX = `${socketPath},${serverPid},${paneIndex}`;
    process.env.TMUX_PANE = paneId;

    const tools = new Map<string, any>();
    const events = { on() {}, emit() {} };
    const pi = {
      events,
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerCommand() {}, registerShortcut() {}, registerFlag() {}, registerMessageRenderer() {},
      getAllTools() { return []; },
      sendMessage() {},
    };
    const { default: subagentsExtension } = await import("../pi-extension/subagents/index.ts");
    subagentsExtension(pi as any);
    const parentSessionFile = join(sessionDir, "parent.jsonl");
    writeFileSync(parentSessionFile, JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: new Date().toISOString(), cwd: root }) + "\n");
    const ctx = {
      cwd: root,
      model: { provider: "fixture-provider", id: "fixture-model" },
      sessionManager: {
        getSessionId: () => "parent-session",
        getSessionFile: () => parentSessionFile,
        getSessionDir: () => sessionDir,
      },
      ui: { setWidget() {}, setStatus() {}, notify() {} },
    };
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    const spawned = await tools.get("subagent").execute("spawn", {
      agent: "fixture-agent", name: "steering-child", task: "Wait for the parent to send a follow-up instruction.",
    }, undefined, undefined, ctx);
    assert.equal(spawned.details?.status, "started", JSON.stringify(spawned));
    childSurface = tmux(socket, "list-panes", "-t", "fixture", "-F", "#{pane_id}").split("\n").find((pane) => pane !== rootPane);
    assert.ok(childSurface, "actual child pane was launched in the isolated tmux session");

    const first = await within(providerOne.promise, 20_000, "Timed out waiting for child's first provider request");
    assert.equal(first.body.model, "fixture-model");
    assert.ok(!JSON.stringify(first.body.messages).includes(marker), "marker must originate only in the later public steering call");

    // Exercise the registered public API; do not inject text through tmux or
    // a fixture hook. The production handler sends the message to real Pi.
    const steered = await tools.get("subagent_message").execute("steer", {
      name: "steering-child", message: `Include this exact token in your next response: ${marker}`,
    }, undefined, undefined, ctx);
    assert.equal(steered.details.status, "steered", "public steering call acknowledged delivery");
    first.release();

    const nextBody = await within(secondRequest.promise, 25_000, "Timed out waiting for the next real provider request after public steering");
    assert.equal(requests.length, 2, "oracle is the immediate next provider request");
    assert.ok(JSON.stringify(nextBody.messages).includes(marker), "the actual next model context must contain the public steering marker");
  } finally {
    firstResponseGate.resolve();
    // Abort the watcher before tearing down its server, avoiding retries/noise
    // against the test's own socket during shutdown.
    handlers.get("session_shutdown")?.({ reason: "shutdown" }, undefined);
    if (tmuxStarted) {
      if (childSurface) {
        try {
          const panes = tmux(socket, "list-panes", "-a", "-F", "#{pane_id}").split("\n");
          if (panes.includes(childSurface)) execFileSync("tmux", ["-L", socket, "kill-pane", "-t", childSurface], { stdio: "ignore" });
        } catch {}
      }
    }
    if (tmuxStarted) {
      try { tmux(socket, "kill-server"); } catch {}
    }
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

});
