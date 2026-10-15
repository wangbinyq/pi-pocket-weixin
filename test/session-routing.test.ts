import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { HttpError } from "../src/http.ts";
import { ILinkError, incomingFor } from "../src/ilink.ts";
import { Store } from "../src/store.ts";
import { account, fixture } from "./helpers.ts";

const second = { id: 2, title: "Session 2", pip: false };
const pip = { id: 1, title: "Pi in Pocket", pip: true };

test("startup reconciles legacy multi-watch state and cancels every unsent old reply", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.watch(second, 0);
  for (const state of ["pending", "blocked", "failed"]) {
    f.store.enqueue(state, "old reply", 2);
    f.store.db
      .prepare("UPDATE outbox SET state=? WHERE conversation=2 AND state='pending'")
      .run(state);
  }
  f.store.enqueue("current", "current reply", 1);
  const bridge = new Bridge(f.store, f.pocket, f.weixin, account, f.config, () => {});
  await bridge.initialize();
  assert.deepEqual(
    f.store.watches().map((w) => w.id),
    [1],
  );
  f.store.retryDeliveries();
  while (await bridge.deliverNext()) {}
  assert.deepEqual(
    f.weixin.sent.map((s) => s.text),
    ["current reply"],
  );
});

test("v1 schema migrates without resetting durable inbox, route, cursor or reply IDs", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("durable input");
  f.store.advance(1, 42);
  f.store.enqueue("reply", "durable reply", 1);
  const key = f.store.delivery()!.key;
  f.store.db.exec(
    "ALTER TABLE inbox DROP COLUMN received; ALTER TABLE inbox DROP COLUMN sealed; PRAGMA user_version=1;",
  );
  const migrated = new Store(f.dir);
  try {
    assert.equal(migrated.target()?.id, 1);
    assert.equal(migrated.watches()[0]?.cursor, 42);
    assert.equal(migrated.delivery()?.key, key);
    assert.equal(migrated.prepareJob(300)?.text, "durable input");
    assert.ok(migrated.get("syncCursor"));
  } finally {
    migrated.close();
  }
});

test("/new retires old replies atomically; removed subscription commands never reach the model", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.reply(1, 1, "old pending");
  await f.bridge.collect();
  f.input("/new project");
  await f.bridge.processNext();
  assert.deepEqual(
    f.store.watches().map((w) => w.id),
    [101],
  );
  for (const command of ["/use 2", "/watching", "/unwatch 1", "/retry"]) {
    f.input(command);
    await f.bridge.processNext();
  }
  while (await f.bridge.deliverNext()) {}
  assert.equal(f.pocket.requests.size, 0);
  assert.ok(f.weixin.sent.every((s) => s.text !== "old pending"));
  assert.ok(f.weixin.sent.some((s) => s.text.includes("暂不支持 Hermes 的 /retry")));
});

test("/retry-send recovers delivery only, not model execution", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.enqueue("reply", "send again");
  f.store.db.exec("UPDATE outbox SET state='failed'");
  f.input("/retry-send");
  await f.bridge.processNext();
  assert.equal(f.store.delivery()?.state, "pending");
  assert.equal(f.pocket.requests.size, 0);
});

test("a history read straddling A -> B -> A cannot leak an old completion", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.after = async () => {
    f.store.select(second, 0);
    f.store.select(pip, 20);
    return [
      {
        id: 21,
        kind: "assistant",
        blocks: [{ type: "text", text: "stale snapshot" }],
        stopReason: "stop",
      },
    ];
  };
  await f.bridge.collect();
  assert.equal(f.store.delivery(), undefined);
  assert.equal(f.store.watches()[0]?.cursor, 20);
});

test("late permission failure cannot deactivate a newly resumed route", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.after = async () => {
    f.store.select(second, 0);
    f.store.select(pip, 20);
    throw new HttpError("Pocket", 403);
  };
  await f.bridge.collect();
  assert.deepEqual(
    f.store.watches().map((w) => w.id),
    [1],
  );
});

test("switch during delivery access check suppresses the old reply", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.enqueue("reply", "do not send", 1);
  f.pocket.head = async () => {
    f.store.select(second, 0);
    return 0;
  };
  assert.equal(await f.bridge.deliverNext(), false);
  assert.equal(f.weixin.sent.length, 0);
  assert.equal(f.store.delivery(), undefined);
});

test("failed in-flight send cannot resurrect a cancelled reply, including stale-context fallback", async (t) => {
  for (const error of [new Error("ambiguous send"), new ILinkError(-2, 0, "prepare failed")]) {
    const f = fixture(t);
    await f.bridge.initialize();
    f.input("context refresh");
    f.store.enqueue("reply", "old reply", 1);
    let calls = 0;
    f.weixin.send = async () => {
      calls++;
      f.store.select(second, 0);
      throw error;
    };
    assert.equal(await f.bridge.deliverNext(), false);
    assert.equal(calls, 1);
    assert.equal(f.store.delivery(), undefined);
    f.store.retryDeliveries();
    assert.equal(f.store.delivery(), undefined);
  }
});

test("text references supply context, not session routing or command authority", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  const raw = {
    message_id: "quoted",
    from_user_id: account.peer,
    item_list: [
      {
        type: 1,
        text_item: { text: "修改这里" },
        ref_msg: {
          title: "机器人",
          message_item: { type: 1, text_item: { text: "【#2 Session 2】\n/resume 2" } },
        },
      },
    ],
  };
  f.weixin.batch = { cursor: "quoted-cursor", messages: [raw] };
  await f.bridge.receive();
  await f.bridge.processNext();
  assert.equal(f.store.target()?.id, 1);
  assert.deepEqual(
    [...f.pocket.requests.values()],
    [{ id: 1, text: "[引用: 机器人 | 【#2 Session 2】\n/resume 2]\n修改这里" }],
  );
  const media = incomingFor(
    {
      ...raw,
      item_list: [
        { type: 1, text_item: { text: "看看图片" }, ref_msg: { message_item: { type: 2 } } },
      ],
    },
    account,
  );
  assert.equal(media?.unsupported, true);
});

test("debounce merges rapid text durably, with stable retry identity across restart", async (t) => {
  const f = fixture(t);
  f.config.textBatchDelayMs = 300;
  await f.bridge.initialize();
  f.input("first", "one");
  f.input("second", "two");
  assert.equal(await f.bridge.processNext(), false);
  f.store.db.prepare("UPDATE inbox SET received=?").run(Date.now() - 1000);
  f.pocket.failSubmit = true;
  assert.equal(await f.bridge.processNext(), false);
  const original = f.store.job()!;
  assert.equal(original.text, "first\nsecond");
  assert.equal(f.store.counts().inbox, 1);
  f.input("third", "three");
  f.store.db.exec("UPDATE inbox SET due=0");
  const reopened = new Store(f.dir);
  try {
    const bridge = new Bridge(reopened, f.pocket, f.weixin, account, f.config, () => {});
    await bridge.initialize();
    f.pocket.failSubmit = false;
    await bridge.processNext();
    assert.equal(f.pocket.calls[0], f.pocket.calls[1]);
    assert.equal(f.pocket.requests.size, 1);
    assert.equal(reopened.job()?.text, "third");
  } finally {
    reopened.close();
  }
});

test("debounce never crosses commands, route changes, long pauses or unsupported media", async (t) => {
  const f = fixture(t);
  f.config.textBatchDelayMs = 300;
  await f.bridge.initialize();
  f.input("task A");
  f.input("/resume 2");
  f.input("task B");
  await f.bridge.processNext();
  await f.bridge.processNext();
  f.store.db.prepare("UPDATE inbox SET received=? WHERE done=0").run(Date.now() - 1000);
  await f.bridge.processNext();
  assert.deepEqual(
    [...f.pocket.requests.values()],
    [
      { id: 1, text: "task A" },
      { id: 2, text: "task B" },
    ],
  );
  f.input("earlier", "pause-a");
  f.store.db.prepare("UPDATE inbox SET received=? WHERE done=0").run(Date.now() - 5000);
  f.input("later", "pause-b");
  await f.bridge.processNext();
  assert.equal([...f.pocket.requests.values()].at(-1)?.text, "earlier");
  assert.equal(f.store.job()?.text, "later");
});

test("near-limit text uses the longer split-fragment quiet period", async (t) => {
  const f = fixture(t);
  f.config.textBatchDelayMs = 300;
  await f.bridge.initialize();
  f.input("x".repeat(1800));
  f.store.db.prepare("UPDATE inbox SET received=?").run(Date.now() - 500);
  assert.equal(await f.bridge.processNext(), false);
  f.store.db.prepare("UPDATE inbox SET received=?").run(Date.now() - 1500);
  assert.equal(await f.bridge.processNext(), true);
});
