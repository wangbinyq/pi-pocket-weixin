import assert from "node:assert/strict";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import { ILinkError } from "../src/ilink.ts";
import { requestJson } from "../src/http.ts";
import { account, fixture } from "./helpers.ts";

test("a newly received token is not erased by an in-flight stale-token failure", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/help");
  await f.bridge.processNext();
  const tokens: (string | undefined)[] = [];
  f.weixin.send = async (_peer, _text, _id, token) => {
    tokens.push(token);
    if (tokens.length === 1) {
      f.store.ingest(account, "new", [
        {
          messageId: "new",
          peer: account.peer,
          text: "new",
          unsupported: false,
          contextToken: "fresh-context",
        },
      ]);
      throw new ILinkError(-2, 0, "prepare failed");
    }
  };
  assert.equal(await f.bridge.deliverNext(), true);
  assert.deepEqual(tokens, ["test-context", "fresh-context"]);
  assert.equal(f.store.get("contextToken"), "fresh-context");
});

test("outbox and history cursor roll back together", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  assert.throws(() =>
    f.store.transaction(() => {
      f.store.enqueue("rollback", "must not escape", 1);
      f.store.advance(1, 100);
      throw new Error("simulated crash");
    }),
  );
  assert.equal(f.store.delivery(), undefined);
  assert.equal(f.store.watches()[0]?.cursor, 0);
});

test("ambiguous send retries retain client ID and stop after eight failed attempts", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.enqueue("send", "hello");
  const ids: string[] = [];
  f.weixin.send = async (_peer, _text, id) => {
    ids.push(id);
    throw new Error("ambiguous HTTP timeout");
  };
  for (let index = 0; index < 8; index++) {
    f.store.db.prepare("UPDATE outbox SET due=0").run();
    await f.bridge.deliverNext();
  }
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.store.delivery()?.state, "failed");
  assert.equal(await f.bridge.deliverNext(), false);
  assert.equal(ids.length, 8);
  f.store.retryDeliveries();
  assert.equal(f.store.delivery()?.state, "pending");
});

test("a second process cannot take an actively held data lock", async (t) => {
  const f = fixture(t);
  const release = await lockfile.lock(f.dir, { retries: 0 });
  try {
    await assert.rejects(lockfile.lock(f.dir, { retries: 0 }), { code: "ELOCKED" });
  } finally {
    await release();
  }
});

test("invalid JSON does not expose response contents in error messages", async () => {
  await assert.rejects(
    requestJson(
      async () => new Response("private token=do-not-print"),
      "https://ilinkai.weixin.qq.com",
      {},
      1000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private|do-not-print/);
      return true;
    },
  );
});
