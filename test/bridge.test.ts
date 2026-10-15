import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { ILinkError } from "../src/ilink.ts";
import { Store } from "../src/store.ts";
import { account, fixture } from "./helpers.ts";

test("default PiP, fixed-ID switching and independent old-session replies", async (t) => {
  const f = fixture(t);
  f.reply(1, 10, "old history must not be forwarded");
  await f.bridge.initialize();
  assert.equal(f.store.target()?.id, 1);
  f.input("first task");
  await f.bridge.processNext();
  f.input("/use 2");
  await f.bridge.processNext();
  f.input("second task");
  await f.bridge.processNext();
  assert.deepEqual(
    [...f.pocket.requests.values()].map((request) => request.id),
    [1, 2],
  );
  f.reply(1, 11, "old task finished");
  f.reply(2, 12, "new task finished");
  await f.bridge.collect();
  while (await f.bridge.deliverNext()) {
    /* drain */
  }
  const text = f.weixin.sent.map((item) => item.text).join("\n");
  assert.match(text, /#1 Pi in Pocket.*\nold task finished/);
  assert.match(text, /#2 Session 2.*\nnew task finished/);
  assert.doesNotMatch(text, /old history must not/);
  await f.bridge.collect();
  assert.equal(f.store.delivery(), undefined);
});

test("inbox retries keep the pinned route and idempotency key", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.failSubmit = true;
  f.input("durable task");
  await f.bridge.processNext();
  const original = f.store.job();
  assert.ok(original?.target);
  f.store.setTarget({ id: 2, title: "Session 2", pip: false });
  f.store.db.prepare("UPDATE inbox SET due=0").run();
  f.pocket.failSubmit = false;
  await f.bridge.processNext();
  assert.equal(f.pocket.calls[0], f.pocket.calls[1]);
  assert.equal(f.pocket.requests.size, 1);
  assert.equal([...f.pocket.requests.values()][0]?.id, 1);
});

test("dedup uses message identity, not repeated content", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("继续", "m1");
  f.input("继续", "m1");
  f.input("继续", "m2");
  await f.bridge.processNext();
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 2);
  assert.equal(f.store.counts().inbox, 0);
});

test("unpaired senders, groups and bot echoes never reach Pocket", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  const message = {
    message_id: "1",
    from_user_id: "stranger",
    item_list: [{ type: 1, text_item: { text: "run a command" } }],
  };
  f.weixin.batch = {
    cursor: "safe",
    messages: [
      message,
      { ...message, from_user_id: account.peer, room_id: "group" },
      { ...message, from_user_id: account.peer, message_type: 2 },
    ],
  };
  await f.bridge.receive();
  assert.equal(f.store.get("syncCursor"), "safe");
  assert.equal(f.store.job(), undefined);
});

test("receive atomically stores inbox, token and cursor; duplicate cannot roll token backward", async (t) => {
  const f = fixture(t);
  f.input("a", "a");
  assert.throws(() =>
    f.store.ingest(account, "bad", [
      { messageId: "bad", peer: "stranger", text: "x", unsupported: false },
    ]),
  );
  assert.equal(f.store.get("syncCursor"), "cursor-a");
  f.store.ingest(account, "new", [
    {
      messageId: "b",
      peer: account.peer,
      text: "b",
      unsupported: false,
      contextToken: "new-token",
    },
  ]);
  f.store.ingest(account, "newer", [
    {
      messageId: "a",
      peer: account.peer,
      text: "a",
      unsupported: false,
      contextToken: "old-token",
    },
  ]);
  assert.equal(f.store.get("contextToken"), "new-token");
});

test("restart retains routing, inbox, outgoing IDs and watermark", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/use 2");
  await f.bridge.processNext();
  f.input("pending");
  f.reply(2, 7, "durable reply");
  await f.bridge.collect();
  const firstId = f.store.delivery()?.key;
  const reopened = new Store(f.dir);
  try {
    const bridge = new Bridge(reopened, f.pocket, f.weixin, account, f.config, () => {});
    await bridge.initialize();
    assert.equal(reopened.target()?.id, 2);
    assert.equal(reopened.delivery()?.key, firstId);
    await bridge.processNext();
    await bridge.collect();
    while (await bridge.deliverNext()) {
      /* drain */
    }
    assert.equal(f.weixin.sent.filter((item) => item.text.includes("durable reply")).length, 1);
  } finally {
    reopened.close();
  }
});

test("new-session uncertain result is never automatically repeated", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.failCreate = true;
  f.input("/new project");
  await f.bridge.processNext();
  await f.bridge.processNext();
  assert.equal(f.pocket.created, 1);
  assert.equal(f.store.target()?.id, 1);
  assert.match(f.store.delivery()?.text || "", /结果不确定/);
});

test("crash after create intent fails closed instead of creating again", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/new project");
  f.store.markCreating(f.store.job()!.key);
  await f.bridge.processNext();
  assert.equal(f.pocket.created, 0);
  assert.match(f.store.delivery()?.text || "", /结果不确定/);
});

test("successful new-session creation atomically selects and acknowledges", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/new project");
  await f.bridge.processNext();
  assert.equal(f.store.target()?.id, 101);
  assert.equal(f.store.job(), undefined);
  assert.match(f.store.delivery()?.text || "", /#101 project/);
});

test("unwatch cancels pending replies, re-subscribe does not replay old history", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.reply(1, 20, "do not send");
  await f.bridge.collect();
  f.input("/unwatch 1");
  await f.bridge.processNext();
  while (await f.bridge.deliverNext()) {
    /* drain */
  }
  assert.ok(f.weixin.sent.every((item) => !item.text.includes("do not send")));
  f.input("new work");
  await f.bridge.processNext();
  await f.bridge.collect();
  assert.equal(f.store.delivery(), undefined);
});

test("stale context retries once without token and persists token removal", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/help");
  await f.bridge.processNext();
  f.weixin.fail = new ILinkError(-2, 0, "prepare failed");
  await f.bridge.deliverNext();
  assert.equal(f.store.get("contextToken"), "");
  assert.equal(f.store.delivery()?.state, "blocked");
  f.input("refresh");
  f.weixin.fail = undefined;
  assert.equal(await f.bridge.deliverNext(), true);
});

test("new identity cannot replay the old account's durable state", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  assert.throws(() => f.store.bind({ ...account, peer: "another" }, f.config.pocketUrl, "owner"));
  f.pocket.user = "another";
  f.input("do not send");
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 0);
});

test("approvals are notifications only and thinking/tool steps stay private", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.rows.get(1)!.push({
    id: 1,
    kind: "assistant",
    blocks: [{ type: "thinking", text: "private reasoning" }, { type: "toolCall" }],
    stopReason: "toolUse",
  });
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 1 }];
  await f.bridge.collect();
  await f.bridge.collect();
  while (await f.bridge.deliverNext()) {
    /* drain */
  }
  assert.equal(f.weixin.sent.length, 1);
  assert.match(f.weixin.sent[0]!.text, /人工审批/);
  assert.doesNotMatch(f.weixin.sent[0]!.text, /private reasoning/);
  f.input("/approve");
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 0);
});

test("access is rechecked before sending a persisted reply", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.reply(1, 1, "secret reply");
  await f.bridge.collect();
  f.pocket.denied.add(1);
  assert.equal(await f.bridge.deliverNext(), false);
  assert.equal(f.weixin.sent.length, 0);
  assert.equal(f.store.delivery(), undefined);
});
