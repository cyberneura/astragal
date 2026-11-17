import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canDispatch, createQueued, mergeUp, rowsFor, takeNext, MERGE_SEPARATOR } from "../src/chat/queue.ts";

const idle = { queued: 1, held: false, busy: false, ready: true, running: true, starting: false };

test("queued messages are dispatched only when the agent is idle and the queue is not held", () => {
  assert.equal(canDispatch(idle), true);
  for (const change of [{ queued: 0 }, { held: true }, { busy: true }, { ready: false }, { running: false }, { starting: true }]) {
    assert.equal(canDispatch({ ...idle, ...change }), false, JSON.stringify(change));
  }
});

test("takeNext returns the oldest message and drops emptied ones", () => {
  const queue = [createQueued("  "), createQueued(" first "), createQueued("second")];
  assert.equal(takeNext(queue), "first");
  assert.deepEqual(queue.map((entry) => entry.text), ["second"]);
  assert.equal(takeNext(queue), "second");
  assert.equal(takeNext(queue), null);
});

test("mergeUp appends a message to the one above and keeps ids unique", () => {
  const queue = [createQueued("a"), createQueued("b"), createQueued("")];
  assert.notEqual(queue[0].id, queue[1].id);
  assert.equal(mergeUp(queue, 0), false);
  assert.equal(mergeUp(queue, 3), false);
  assert.equal(mergeUp(queue, 1), true);
  assert.deepEqual(queue.map((entry) => entry.text), [`a${MERGE_SEPARATOR}b`, ""]);
  assert.equal(mergeUp(queue, 1), true);
  assert.deepEqual(queue.map((entry) => entry.text), [`a${MERGE_SEPARATOR}b`]);
});

test("rowsFor grows with lines and stops at six", () => {
  assert.equal(rowsFor(""), 1);
  assert.equal(rowsFor("a\nb"), 2);
  assert.equal(rowsFor("1\n2\n3\n4\n5\n6\n7\n8"), 6);
});
