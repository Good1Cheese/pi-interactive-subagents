import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

test("Pi event-bus launch hooks are synchronous only before a listener's first await", async () => {
  const events = createEventBus();
  const request = { provided: false };
  let asyncContinuation = false;
  events.on("prepare", (data) => {
    (data as typeof request).provided = true;
  });
  events.on("prepare", async () => {
    await Promise.resolve();
    asyncContinuation = true;
  });

  events.emit("prepare", request);
  assert.equal(request.provided, true, "synchronous responder ran during emit");
  assert.equal(asyncContinuation, false, "emit does not await asynchronous listener work");
  await Promise.resolve();
  assert.equal(asyncContinuation, true);
});
