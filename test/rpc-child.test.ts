import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchRpcChild } from "../pi-extension/subagents/rpc-child.ts";

function fakePi(root: string, behavior = "accept") {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const trace = join(root, "commands.jsonl");
  const executable = join(bin, "pi");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const trace = process.env.FAKE_PI_TRACE;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  fs.appendFileSync(trace, JSON.stringify(command) + '\\n');
  const behavior = process.env.FAKE_PI_BEHAVIOR;
  if (behavior === 'null-output') { process.stdout.write('null\\n'); setInterval(() => {}, 1000); return; }
  const disposition = behavior === 'handled' ? 'handled' : 'started';
  if (behavior === 'stdin-close' && !command.streamingBehavior) {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true, data: { disposition } }) + '\\n');
    process.stdin.pause();
    setTimeout(() => process.stdin.destroy(), 100);
    return;
  }
  if (behavior === 'lost' && command.streamingBehavior) { process.exit(0); }
  if (behavior === 'stdin-close' && command.streamingBehavior) {
    process.stdin.destroy();
    setTimeout(() => process.exit(0), 1000);
    return;
  }
  if (behavior === 'stdout-error' && command.streamingBehavior) {
    process.stdout.destroy(new Error('fake stdout error'));
    setTimeout(() => process.exit(0), 1000);
    return;
  }
  process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: behavior === 'bad-ack' && command.streamingBehavior ? 'true' : behavior !== 'reject', data: { disposition } }) + '\\n');
  if (behavior === 'ui' && command.type === 'prompt' && !command.streamingBehavior) {
    setTimeout(() => process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['a', 'b'] }) + '\\n'), 30);
  }
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
  if (behavior === 'backpressure' && !command.streamingBehavior) { process.stdin.pause(); setInterval(() => {}, 1000); }
});
`);
  chmodSync(executable, 0o755);
  return { bin, trace, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_PI_TRACE: trace, FAKE_PI_BEHAVIOR: behavior } };
}

test("RPC child sends one initial prompt, correlates steering ACK, and closes orderly", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root);
    let activity = 0;
    const child = launchRpcChild({ args: ["--no-session"], cwd: root, env: fake.env, initialMessage: "start", onActivity: () => activity++ });
    assert.equal(await child.steer("redirect"), "accepted");
    await child.close();
    assert.deepEqual((await child.finished).exitCode, 0);
    const commands = readFileSync(fake.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(commands.map(command => [command.type, command.message, command.streamingBehavior]), [
      ["prompt", "start", undefined],
      ["prompt", "redirect", "steer"],
    ]);
    assert.ok(activity > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child shuts down after invalid JSON protocol records", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root, "null-output");
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
    const result = await Promise.race([
      child.finished,
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 4_000)),
    ]);
    assert.notEqual(result, "timeout");
    assert.ok(typeof result === "object");
    assert.match(result.errorMessage ?? "", /protocol/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child isolates activity callback failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root);
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start", onActivity: () => { throw new Error("observer failed"); } });
    assert.equal(await child.steer("redirect"), "accepted");
    await child.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child ends input when initial prompt is handled or rejected", async t => {
  for (const behavior of ["handled", "reject"] as const) {
    await t.test(behavior, async () => {
      const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
      try {
        const fake = fakePi(root, behavior);
        const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
        const result = await child.finished;
        assert.equal(result.exitCode, 0);
        assert.match(result.errorMessage ?? "", /initial prompt/i, "a clean process exit must not hide input rejection or no-run");
        assert.equal(readFileSync(fake.trace, "utf8").trim().split("\n").length, 1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test("RPC child settles a backpressured write when child stdin closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root, "stdin-close");
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
    const result = await Promise.race([
      child.steer("x".repeat(900_000)),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(result, "unknown");
    await child.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child bounds steering when an open pipe never drains", async t => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  let child: ReturnType<typeof launchRpcChild> | undefined;
  try {
    const fake = fakePi(root, "backpressure");
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start", onActivity: () => ready() });
    await started;
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const steering = child.steer("x".repeat(900_000));
    t.mock.timers.tick(30_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(await Promise.race([steering, Promise.resolve("still waiting")]), "unknown");
  } finally {
    t.mock.timers.reset();
    await child?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC child settles steering when stdout errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root, "stdout-error");
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
    const result = await Promise.race([
      child.steer("redirect"),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 500)),
    ]);
    assert.equal(result, "unknown");
    await child.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child forwards UI requests using the current callback", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root, "ui");
    let staleCalls = 0;
    let currentRequest: unknown;
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start", onUiRequest: async () => { staleCalls++; return { value: "stale" }; } });
    child.onUiRequest = async request => { currentRequest = request; return { value: "b", confirmed: true }; };
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(staleCalls, 0);
    assert.deepEqual(currentRequest, { type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["a", "b"] });
    const commands = readFileSync(fake.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(commands.filter(command => command.type === "extension_ui_response"), [
      { type: "extension_ui_response", id: "ui-1", confirmed: true, value: "b" },
    ]);
    await child.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child cancels UI requests without a handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root, "ui");
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
    await new Promise(resolve => setTimeout(resolve, 100));
    const commands = readFileSync(fake.trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(commands.filter(command => command.type === "extension_ui_response"), [
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
    ]);
    await child.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("RPC child does not accept non-boolean acknowledgements", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  let child: ReturnType<typeof launchRpcChild> | undefined;
  try {
    const fake = fakePi(root, "bad-ack");
    child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
    assert.equal(await child.steer("redirect"), "unknown");
  } finally {
    await child?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("RPC child reports lost steering acknowledgements as unknown without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-child-"));
  try {
    const fake = fakePi(root, "lost");
    const child = launchRpcChild({ args: [], cwd: root, env: fake.env, initialMessage: "start" });
    assert.equal(await child.steer("redirect"), "unknown");
    await child.close();
    assert.equal(readFileSync(fake.trace, "utf8").trim().split("\n").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
