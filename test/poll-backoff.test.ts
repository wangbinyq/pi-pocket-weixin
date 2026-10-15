import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { ILinkError } from "../src/ilink.ts";
import { fixture } from "./helpers.ts";

for (const error of [
  new ILinkError(-14, 0, "expired"),
  new ILinkError(-2, 0, "prepare failed"),
  new ILinkError(0, -2, "unknown error"),
]) {
  test(`polling ${error.kind} pauses for ten minutes without advancing cursor`, async (t) => {
    const f = fixture(t);
    await f.bridge.initialize();
    const controller = new AbortController();
    let polls = 0;
    f.weixin.updates = async () => {
      polls++;
      throw error;
    };
    f.bridge.processNext = async () => false;
    f.bridge.collect = async () => {};
    f.bridge.deliverNext = async () => false;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.timers.reset();
      syncBuiltinESMExports();
    });
    const running = f.bridge.run(controller.signal);
    try {
      await setImmediate();
      assert.equal(polls, 1);
      t.mock.timers.tick(599_999);
      await setImmediate();
      assert.equal(polls, 1);
      t.mock.timers.tick(1);
      await setImmediate();
      assert.equal(polls, 2);
      assert.equal(f.store.get("syncCursor"), undefined);
    } finally {
      controller.abort();
      await running;
    }
  });
}

test("transient polling errors back off 2s, 2s, 30s then reset", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  const controller = new AbortController();
  let polls = 0;
  f.weixin.updates = async () => {
    polls++;
    throw new Error("network unavailable");
  };
  f.bridge.processNext = async () => false;
  f.bridge.collect = async () => {};
  f.bridge.deliverNext = async () => false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
  const running = f.bridge.run(controller.signal);
  try {
    await setImmediate();
    assert.equal(polls, 1);
    for (const [delay, expected] of [
      [2000, 2],
      [2000, 3],
      [30_000, 4],
      [2000, 5],
    ]) {
      t.mock.timers.tick(delay! - 1);
      await setImmediate();
      assert.equal(polls, expected! - 1);
      t.mock.timers.tick(1);
      await setImmediate();
      assert.equal(polls, expected);
    }
  } finally {
    controller.abort();
    await running;
  }
});
