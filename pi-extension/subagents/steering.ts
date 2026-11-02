import { randomBytes } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STEERING_SOCKET_ENV = "PI_SUBAGENT_STEERING_SOCKET";
export const STEERING_GENERATION_ENV = "PI_SUBAGENT_STEERING_GENERATION";

const MAX_TEXT_BYTES = 32 * 1024;
const MAX_FRAME_BYTES = MAX_TEXT_BYTES * 6 + 1024;
const ACK_TIMEOUT_MS = 2_000;

export type SteeringResult = "accepted" | "rejected" | "unknown";

export interface SteeringEndpoint {
  socketPath: string;
  generation: string;
  dispose(): void;
}

/** Create a private short-path socket directory and one-use launch generation. */
export function createSteeringEndpoint(): SteeringEndpoint {
  const directory = mkdtempSync(join(tmpdir(), "pi-s-"));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "s");
  if (Buffer.byteLength(socketPath) >= 100) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("Temporary directory is too long for a Unix-domain socket path");
  }
  return {
    socketPath,
    generation: randomBytes(24).toString("hex"),
    dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** One delivery attempt only. An ambiguous transport failure is never retried. */
export function sendSteeringMessage(
  socketPath: string,
  generation: string,
  text: string,
): Promise<SteeringResult> {
  if (!socketPath || !generation || typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    return Promise.resolve("rejected");
  }

  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let socket: Socket | undefined;
    const timer = setTimeout(() => finish("unknown"), ACK_TIMEOUT_MS);
    const finish = (result: SteeringResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = connect(socketPath);
    } catch {
      finish("unknown");
      return;
    }
    socket.once("connect", () => {
      const frame = JSON.stringify({ generation, text }) + "\n";
      socket.write(frame, (error) => {
        if (error) finish("unknown");
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > 1024) return finish("unknown");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        finish(reply?.status === "accepted" ? "accepted" : reply?.status === "rejected" ? "rejected" : "unknown");
      } catch {
        finish("unknown");
      }
    });
    socket.once("error", () => finish("unknown"));
    socket.once("close", () => { if (!settled) finish("unknown"); });
  });
}

/** Listen for one-frame steering requests and inject accepted messages through Pi's public API. */
export async function startSteeringReceiver(
  pi: { sendUserMessage(content: string, options?: { deliverAs?: "steer" }): void },
  socketPath: string,
  generation: string,
): Promise<() => Promise<void>> {
  if (!socketPath || !generation) throw new Error("Steering socket path and generation are required");
  const sockets = new Set<Socket>();
  let closed = false;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(ACK_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        handled = true;
        reply(socket, "rejected");
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      handled = true;
      try {
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (closed || request?.generation !== generation || typeof request?.text !== "string" || !request.text.trim() || Buffer.byteLength(request.text, "utf8") > MAX_TEXT_BYTES) {
          reply(socket, "rejected");
          return;
        }
        try {
          pi.sendUserMessage(request.text, { deliverAs: "steer" });
        } catch {
          socket.destroy();
          return;
        }
        reply(socket, "accepted");
      } catch {
        reply(socket, "rejected");
      }
    });
  });

  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
    server.close(() => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); }
      catch (error) { server.close(() => {}); reject(error); return; }
      server.removeListener("error", reject);
      resolve();
    });
  });

  return async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { unlinkSync(socketPath); } catch { /* already removed */ }
  };
}

function reply(socket: Socket, status: "accepted" | "rejected"): void {
  socket.end(JSON.stringify({ status }) + "\n");
}
