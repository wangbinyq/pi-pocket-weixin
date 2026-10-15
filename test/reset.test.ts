import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { HttpError } from "../src/http.ts";
import { Pocket } from "../src/pocket.ts";
import { Store } from "../src/store.ts";
import { account, fixture } from "./helpers.ts";

test("Pocket reset uses the authenticated native API, preserving the handoff verbatim", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const pocket = new Pocket("https://pocket.example.com", "test-token", {
    fetcher: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true });
    },
  });
  await pocket.reset(12);
  await pocket.reset(12, "保留项目约束\n  不要自动部署");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://pocket.example.com/api/c/12/reset");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer test-token");
    assert.equal(new Headers(call.init.headers).get("X-Pocket"), "1");
  }
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {});
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    note: "保留项目约束\n  不要自动部署",
  });
  const invalid = new Pocket("https://pocket.example.com", "test-token", {
    fetcher: async () => Response.json({ ok: false }),
  });
  await assert.rejects(invalid.reset(12));
});

for (const otherSession of [false, true]) {
  test(`/reset targets ${otherSession ? "the resumed session" : "PiP"} without changing routes, cursor or pending replies`, async (t) => {
    const f = fixture(t);
    await f.bridge.initialize();
    if (otherSession) {
      f.input("/resume 2");
      await f.bridge.processNext();
      while (await f.bridge.deliverNext()) {}
    }
    const target = f.store.target()!;
    f.reply(target.id, 10, "earlier final reply");
    await f.bridge.collect();
    const watches = f.store.watches();
    const generation = f.store.generation();
    const previousReply = f.store.delivery()!.key;
    f.pocket.active = [{ id: target.id, title: target.title, busy: true, approvals: 0 }];
    const note = otherSession ? "保留项目路径\n  不自动提交" : undefined;
    const command = note ? `/reset ${note}` : "/reset";
    f.input(command, "reset-once");
    await f.bridge.processNext();
    f.input(command, "reset-once");
    await f.bridge.processNext();
    assert.deepEqual(f.pocket.resets, [{ id: target.id, ...(note ? { note } : {}) }]);
    assert.deepEqual(f.store.target(), target);
    assert.deepEqual(f.store.watches(), watches);
    assert.equal(f.store.generation(), generation);
    assert.equal(f.store.delivery()?.key, previousReply);
    assert.equal(f.pocket.created, 0);
    assert.equal(f.pocket.requests.size, 0);
    assert.equal(f.store.job(), undefined);
    assert.equal(f.store.get("resetIntent"), "");
    while (await f.bridge.deliverNext()) {}
    assert.ok(f.weixin.sent.some((message) => message.text === "earlier final reply"));
    assert.ok(f.weixin.sent.some((message) => /历史记录保留，会话 ID 不变/.test(message.text)));
    assert.ok(
      f.weixin.sent.some((message) => /下一处理边界生效，不停止当前任务/.test(message.text)),
    );
  });
}

test("ambiguous reset is never automatically repeated; a distinct explicit command is allowed", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.reset = async (id, note) => {
    f.pocket.resets.push({ id, note });
    throw new Error("Response lost after server commit");
  };
  f.input("/reset keep project", "reset-failure");
  await f.bridge.processNext();
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 1);
  assert.equal(f.store.job(), undefined);
  assert.equal(f.store.get("resetIntent"), "");
  assert.match(f.store.delivery()?.text || "", /结果不确定，未自动重试/);
  f.input("/reset keep project", "reset-failure");
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 1);
  f.pocket.reset = async (id, note) => {
    f.pocket.resets.push({ id, note });
  };
  f.input("/reset", "reset-explicit-retry");
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 2);
});

for (const accepted of [false, true]) {
  test(`restart after reset intent ${accepted ? "and server acceptance" : "but before sending"} fails closed`, async (t) => {
    const f = fixture(t);
    await f.bridge.initialize();
    f.input("/reset handoff");
    const job = f.store.job()!;
    f.store.beginReset(job.key, f.store.target()!);
    if (accepted) await f.pocket.reset(1, "handoff");
    const reopened = new Store(f.dir);
    try {
      const bridge = new Bridge(reopened, f.pocket, f.weixin, account, f.config, () => {});
      await bridge.initialize();
      assert.ok(reopened.job()?.target);
      await bridge.processNext();
      assert.equal(f.pocket.resets.length, accepted ? 1 : 0);
      assert.equal(reopened.job(), undefined);
      assert.equal(reopened.get("resetIntent"), "");
      assert.match(reopened.delivery()?.text || "", /上次 \/reset 的结果不确定/);
    } finally {
      reopened.close();
    }
  });
}

test("reset rejects oversized handoff and reports deterministic Pocket refusals without retry", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/reset " + "字".repeat(20_001));
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 0);
  assert.match(f.store.delivery()?.text || "", /不能超过 20000/);
  while (await f.bridge.deliverNext()) {}
  f.pocket.reset = async () => {
    throw new HttpError("Pocket", 403);
  };
  f.input("/reset");
  await f.bridge.processNext();
  assert.match(f.store.delivery()?.text || "", /未接受 \/reset（HTTP 403）/);
  assert.equal(f.store.job(), undefined);
  assert.equal(f.store.get("resetIntent"), "");
});

test("reset does not execute for a changed principal, missing route or unsupported attachment", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.user = "another-user";
  f.input("/reset", "identity-denied");
  assert.equal(await f.bridge.processNext(), false);
  assert.equal(f.pocket.resets.length, 0);
  assert.equal(f.store.get("resetIntent"), undefined);
  f.pocket.user = "owner";
  f.store.finish(f.store.job()!.key);
  f.store.db.prepare("DELETE FROM meta WHERE key='target'").run();
  f.input("/reset", "missing-target");
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 0);
  assert.match(f.store.delivery()?.text || "", /没有目标会话/);
  f.weixin.batch = {
    cursor: "media",
    messages: [
      {
        message_id: "unsupported",
        from_user_id: account.peer,
        item_list: [{ type: 1, text_item: { text: "/reset" } }, { type: 2 }],
      },
    ],
  };
  await f.bridge.receive();
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 0);
  assert.equal(f.store.counts().inbox, 0);
});

test("reset is a debounce boundary and never becomes ordinary model input", async (t) => {
  const f = fixture(t);
  f.config.textBatchDelayMs = 300;
  await f.bridge.initialize();
  f.input("before reset");
  f.input("/reset keep only the goal");
  f.input("after reset");
  await f.bridge.processNext();
  await f.bridge.processNext();
  f.store.db.prepare("UPDATE inbox SET received=? WHERE done=0").run(Date.now() - 1000);
  await f.bridge.processNext();
  assert.deepEqual(
    [...f.pocket.requests.values()].map((request) => request.text),
    ["before reset", "after reset"],
  );
  assert.deepEqual(f.pocket.resets, [{ id: 1, note: "keep only the goal" }]);
});
