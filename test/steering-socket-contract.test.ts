import assert from "node:assert/strict";
import test from "node:test";
import {
  createSteeringEndpoint,
  sendSteeringMessage,
  startSteeringReceiver,
} from "../pi-extension/subagents/steering.ts";

test("generation-bound socket accepts exactly one valid steer and rejects stale generations", async () => {
  const endpoint = createSteeringEndpoint();
  const received: Array<{ text: string; delivery: string | undefined }> = [];
  const close = await startSteeringReceiver(
    { sendUserMessage: (text, options) => received.push({ text, delivery: options?.deliverAs }) },
    endpoint.socketPath,
    endpoint.generation,
  );
  try {
    assert.equal(await sendSteeringMessage(endpoint.socketPath, endpoint.generation, "next request"), "accepted");
    assert.deepEqual(received, [{ text: "next request", delivery: "steer" }]);
    assert.equal(await sendSteeringMessage(endpoint.socketPath, "stale-generation", "do not deliver"), "rejected");
    assert.equal(await sendSteeringMessage(endpoint.socketPath, endpoint.generation, "x".repeat(32 * 1024 + 1)), "rejected");
    assert.deepEqual(received, [{ text: "next request", delivery: "steer" }]);
    const escaped = `${'"'.repeat(16 * 1024)}\n${"\\".repeat(16 * 1024 - 1)}`;
    assert.equal(await sendSteeringMessage(endpoint.socketPath, endpoint.generation, escaped), "accepted");
    assert.deepEqual(received.at(-1), { text: escaped, delivery: "steer" });
  } finally {
    await close();
    await close();
    endpoint.dispose();
  }
  assert.equal(await sendSteeringMessage(endpoint.socketPath, endpoint.generation, "after close"), "unknown");
});

test("lost acknowledgement after Pi admission stays unknown and is never replayed", async () => {
  const endpoint = createSteeringEndpoint();
  let attempts = 0;
  const close = await startSteeringReceiver({
    sendUserMessage() {
      attempts++;
      throw new Error("admission outcome is uncertain");
    },
  }, endpoint.socketPath, endpoint.generation);
  try {
    assert.equal(await sendSteeringMessage(endpoint.socketPath, endpoint.generation, "do not repeat"), "unknown");
    assert.equal(attempts, 1);
  } finally {
    await close();
    endpoint.dispose();
  }
});
