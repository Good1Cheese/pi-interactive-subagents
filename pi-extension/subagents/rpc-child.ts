import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const MAX_FRAME_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 30_000;
const GRACEFUL_CLOSE_MS = 1_500;
const TERM_CLOSE_MS = 1_000;

type RpcResponse = { type: "response"; id?: string; success?: boolean; data?: { disposition?: string } };

export type ExtensionUiRequest = Record<string, unknown> & { id: string; type: "extension_ui_request" };
export type ExtensionUiResponseFields = {
  confirmed?: boolean;
  value?: string;
  cancelled?: boolean;
};

export interface RpcChildHandle {
  finished: Promise<{ exitCode: number; errorMessage?: string }>;
  onActivity?: () => void;
  onUiRequest?: (request: ExtensionUiRequest) => Promise<ExtensionUiResponseFields>;
  steer(text: string): Promise<"accepted" | "rejected" | "unknown">;
  close(): Promise<void>;
}

export function launchRpcChild(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  initialMessage: string;
  onActivity?: () => void;
  onUiRequest?: (request: ExtensionUiRequest) => Promise<ExtensionUiResponseFields>;
}): RpcChildHandle {
  const child: ChildProcess = spawn("pi", ["--mode", "rpc", ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let output = Buffer.alloc(0);
  let closed = false;
  let ioFailed = false;
  let errorMessage: string | undefined;
  let requestNumber = 0;
  const requests = new Map<string, { resolve: (response: RpcResponse | undefined) => void; timer: NodeJS.Timeout }>();
  let closePromise: Promise<void> | undefined;
  let resolveFinished!: (result: { exitCode: number; errorMessage?: string }) => void;
  const finished = new Promise<{ exitCode: number; errorMessage?: string }>(resolve => { resolveFinished = resolve; });

  let handle!: RpcChildHandle;
  const finishRequest = (id: string, response?: RpcResponse) => {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    clearTimeout(request.timer);
    request.resolve(response);
  };
  const endInput = () => { if (!closed && child.stdin && !child.stdin.destroyed) child.stdin.end(); };
  const failIo = () => {
    if (ioFailed) return;
    ioFailed = true;
    for (const id of requests.keys()) finishRequest(id);
  };
  const write = async (record: object, deadline?: number): Promise<boolean> => {
    const stdin = child.stdin;
    if (closed || ioFailed || !stdin || stdin.destroyed || !stdin.writable) return false;
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return false;
    try {
      if (!stdin.write(line)) {
        if (stdin.destroyed || closed || ioFailed) { failIo(); return false; }
        const outcome = await new Promise<"drain" | "error" | "close" | "timeout">(resolve => {
          let timer: NodeJS.Timeout | undefined;
          const cleanup = () => {
            stdin.off("drain", onDrain);
            stdin.off("error", onError);
            stdin.off("close", onClose);
            if (timer) clearTimeout(timer);
          };
          const settle = (result: "drain" | "error" | "close" | "timeout") => { cleanup(); resolve(result); };
          const onDrain = () => settle("drain");
          const onError = () => settle("error");
          const onClose = () => settle("close");
          stdin.once("drain", onDrain);
          stdin.once("error", onError);
          stdin.once("close", onClose);
          if (deadline !== undefined) timer = setTimeout(() => settle("timeout"), Math.max(0, deadline - Date.now()));
        });
        if (outcome !== "drain") { failIo(); return false; }
      }
    } catch { failIo(); return false; }
    return !closed && !ioFailed;
  };
  const request = async (command: string, fields: Record<string, unknown>): Promise<RpcResponse | undefined> => {
    const id = `subagent-${process.pid}-${++requestNumber}`;
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    const response = new Promise<RpcResponse | undefined>(resolve => {
      const timer = setTimeout(() => finishRequest(id), RESPONSE_TIMEOUT_MS);
      requests.set(id, { resolve, timer });
    });
    await Promise.race([write({ id, type: command, ...fields }, deadline), response]);
    return response;
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]);
    if (output.length > MAX_FRAME_BYTES && !output.includes(10)) {
      output = Buffer.alloc(0);
      errorMessage ??= "RPC child protocol frame exceeded the size limit";
      void close();
      return;
    }
    let newline: number;
    while ((newline = output.indexOf(10)) >= 0) {
      let line = output.subarray(0, newline);
      output = output.subarray(newline + 1);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length > MAX_FRAME_BYTES) { errorMessage ??= "RPC child protocol frame exceeded the size limit"; void close(); continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(line.toString("utf8")); } catch { errorMessage ??= "RPC child protocol record was invalid"; void close(); continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { errorMessage ??= "RPC child protocol record was invalid"; void close(); continue; }
      const record = parsed as Record<string, unknown>;
      if (record.type === "response" && typeof record.id === "string") {
        finishRequest(record.id, record as RpcResponse);
      } else if (record.type === "extension_ui_request" && typeof record.id === "string") {
        void (async () => {
          let response: ExtensionUiResponseFields = { cancelled: true };
          try {
            if (handle.onUiRequest) response = await handle.onUiRequest(record as ExtensionUiRequest);
          } catch { /* A failed UI bridge must not strand the child request. */ }
          await write({ type: "extension_ui_response", id: record.id, ...response });
        })();
      } else if (record.type !== "message_update") {
        try { handle.onActivity?.(); } catch { /* Activity observers must not crash the host. */ }
      }
    }
    if (output.length > MAX_FRAME_BYTES) { output = Buffer.alloc(0); errorMessage ??= "RPC child protocol frame exceeded the size limit"; void close(); }
  });
  child.stderr?.resume();
  child.stdin?.on("error", failIo);
  child.stdin?.on("close", failIo);
  child.stdout?.on("error", failIo);
  child.stdout?.on("close", failIo);
  child.on("error", () => { failIo(); endInput(); });
  child.on("close", (code) => {
    closed = true;
    for (const id of requests.keys()) finishRequest(id);
    if (code === null) errorMessage ??= "RPC child exited without an exit code";
    resolveFinished({ exitCode: code ?? 1, ...(errorMessage ? { errorMessage } : {}) });
  });

  const initial = request("prompt", { message: options.initialMessage });
  void initial.then(response => {
    if (!response || response.success !== true || response.data?.disposition !== "started") {
      errorMessage ??= !response ? "RPC initial prompt acknowledgement is unknown" : "RPC initial prompt did not start an agent run";
      void close();
    }
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      endInput();
      let timer: NodeJS.Timeout | undefined;
      const wait = (ms: number) => Promise.race([finished.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]).finally(() => { if (timer) clearTimeout(timer); });
      if (await wait(GRACEFUL_CLOSE_MS)) return;
      child.kill("SIGTERM");
      if (await wait(TERM_CLOSE_MS)) return;
      child.kill("SIGKILL");
      await finished;
    })();
    return closePromise;
  };

  handle = {
    finished,
    onActivity: options.onActivity,
    onUiRequest: options.onUiRequest,
    async steer(text) {
      const response = await request("prompt", { message: text, streamingBehavior: "steer" });
      if (!response) return "unknown";
      return response.success === true ? "accepted" : response.success === false ? "rejected" : "unknown";
    },
    close,
  };
  return handle;
}
