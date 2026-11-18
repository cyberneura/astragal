import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FOLLOW_BOTTOM_PX, isAtBottom, shouldFollowBottom } from "../src/chat/scroll.ts";

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

test("isAtBottom uses the follow threshold", () => {
  assert.equal(isAtBottom(at(1500)), true);
  assert.equal(isAtBottom(at(1500 - FOLLOW_BOTTOM_PX)), true);
  assert.equal(isAtBottom(at(1500 - FOLLOW_BOTTOM_PX - 1)), false);
});

test("a small upward scroll near the end stops following", () => {
  // Inside the old 64px window: this used to be pulled back on the next streaming render
  assert.equal(shouldFollowBottom(true, at(1500), at(1490)), false);
});

test("staying above the end keeps following off; returning to the bottom resumes it", () => {
  assert.equal(shouldFollowBottom(false, at(1000), at(1200)), false);
  assert.equal(shouldFollowBottom(false, at(1200), at(1480)), true);
});

test("content growing below the reader does not change the decision", () => {
  assert.equal(shouldFollowBottom(true, at(1500), at(1500, 2400)), true);
  assert.equal(shouldFollowBottom(false, at(800), at(800, 2400)), false);
});

test("the browser clamping scrollTop when content shrinks is not the user moving up", () => {
  assert.equal(shouldFollowBottom(true, at(1500), at(1300, 1800)), true);
});

test("rubber band settling back at the end is not the user moving up", () => {
  assert.equal(shouldFollowBottom(true, at(1510), at(1500)), true);
});
