import assert from "node:assert/strict";
import test from "node:test";
import { isWorkerReady } from "./readiness";

test("is ready only after group join with healthy processing", () => {
  assert.equal(
    isWorkerReady({
      groupJoined: true,
      processingBlocked: false,
      shuttingDown: false,
    }),
    true,
  );
});

test("stays unready after a failed batch even if the consumer rejoins", () => {
  assert.equal(
    isWorkerReady({
      groupJoined: true,
      processingBlocked: true,
      shuttingDown: false,
    }),
    false,
  );
});

test("is unready while disconnected or shutting down", () => {
  assert.equal(
    isWorkerReady({
      groupJoined: false,
      processingBlocked: false,
      shuttingDown: false,
    }),
    false,
  );
  assert.equal(
    isWorkerReady({
      groupJoined: true,
      processingBlocked: false,
      shuttingDown: true,
    }),
    false,
  );
});
