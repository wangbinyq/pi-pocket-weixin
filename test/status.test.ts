import assert from "node:assert/strict";
import { test } from "node:test";
import { Pocket } from "../src/pocket.ts";
import { statusText } from "../src/status.ts";
import { Store } from "../src/store.ts";
import { fixture } from "./helpers.ts";

const session = "bdb9c089-9447-4e7b-a4fc-1e73eab6db6f";
const data = {
  model: { provider: "test", modelId: "model" },
  contextTokens: 12345,
  contextWindow: 100000,
  contextEstimated: true,
};

test("Pocket diagnostics reads the first matching full view and always closes its poller", async () => {
  const calls: URL[] = [];
  const pocket = new Pocket("http://127.0.0.1:8787", "canary", {
    fetcher: async (url, init) => {
      const request = new URL(String(url));
      calls.push(request);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer canary");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.method ?? "GET", "GET");
      assert.ok(init?.signal);
      if (request.searchParams.get("close")) return Response.json({ ok: true });
      return Response.json({
        session,
        events: [
          { event: "hello", data: { user: { id: "owner" } } },
          {
            event: "view",
            data: {
              conversation: { id: 8 },
              agent: { model: { provider: "wrong", modelId: "wrong" } },
              stats: {},
            },
          },
          {
            event: "view",
            data: {
              conversation: { id: 7 },
              agent: { model: data.model, contextWindow: data.contextWindow },
              stats: { contextTokens: data.contextTokens, contextEstimated: true },
              entries: [{ text: "private-canary" }],
            },
          },
        ],
      });
    },
  });
  assert.deepEqual(await pocket.diagnostics(7), data);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.search, "?c=7");
  assert.equal(calls[1]!.searchParams.get("session"), session);
  assert.equal(calls[1]!.searchParams.get("close"), "1");
});

for (const scenario of [
  "missing",
  "malformed",
  "close-fails",
  "http-error",
  "timeout",
  "invalid-json",
]) {
  test(`Pocket diagnostics degrades safely: ${scenario}`, async () => {
    let closes = 0;
    const pocket = new Pocket("https://pocket.example.com", "canary", {
      fetcher: async (url) => {
        if (String(url).includes("close=1")) {
          closes++;
          if (scenario === "close-fails") throw new Error("private-canary");
          return Response.json({ ok: true });
        }
        if (scenario === "http-error") return new Response("private-canary", { status: 503 });
        if (scenario === "timeout") throw new DOMException("timeout-canary", "TimeoutError");
        if (scenario === "invalid-json") return new Response("invalid-canary");
        return Response.json({ session, events: scenario === "malformed" ? "bad" : [] });
      },
    });
    assert.deepEqual(await pocket.diagnostics(7), {});
    assert.equal(closes, ["http-error", "timeout", "invalid-json"].includes(scenario) ? 0 : 1);
  });
}

test("/status shows current route, model/context, all queue states, window and bridge runtime", async (t) => {
  const f = fixture(t);
  f.pocket.diagnosticData = data;
  await f.bridge.initialize();
  f.store.enqueue("blocked", "old");
  const row = f.store.delivery()!;
  f.store.deliveryFailed(row, true);
  f.store.enqueue("failed", "later");
  f.store.db.prepare("UPDATE outbox SET state='failed' WHERE text='later'").run();
  f.input("/status");
  f.store.db.prepare("UPDATE outbox SET state='blocked' WHERE key=?").run(row.key);
  await f.bridge.processNext();
  const output = f.store.db
    .prepare("SELECT text FROM outbox WHERE text LIKE '%上下文%'")
    .get()?.text;
  assert.equal(typeof output, "string");
  assert.match(String(output), /\[#1\]\(https:\/\/pocket\.example\.com\/s\/1\) Pi in Pocket/);
  assert.match(String(output), /路由 同步中 · 游标 0/);
  assert.match(String(output), /模型 test\/model/);
  assert.match(String(output), /上下文 12345\/100000 tokens/);
  assert.match(String(output), /12\.3% · Pocket估算/);
  assert.match(String(output), /队列 入0 待发0/);
  assert.match(String(output), /blocked=1 failed=1/);
  assert.match(String(output), /24h OPEN/);
  assert.match(String(output), /桥接 0\.1\.0\+/);
  assert.match(String(output), /重启 \d{4}-/);
  assert.deepEqual(f.pocket.diagnosticIds, [1]);
});

test("/status remains useful when optional Pocket diagnostics fail", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.diagnostics = async () => {
    throw new Error("private diagnostic failure");
  };
  f.pocket.running = async () => {
    throw new Error("private running failure");
  };
  f.input("/status");
  await f.bridge.processNext();
  while (await f.bridge.deliverNext()) {}
  const text = f.weixin.sent.at(-1)!.text;
  assert.match(text, /模型 unknown/);
  assert.match(text, /上下文 unknown\/unknown/);
  assert.match(text, /Pocket unknown/);
  assert.ok(!text.includes("private"));
  assert.equal(f.pocket.requests.size, 0);
});

test("status window is conspicuous at 24h and unknown is not zero", () => {
  const base = {
    diagnostics: {},
    counts: { inbox: 2, pending: 3, blocked: 1, failed: 1 },
    runningKnown: false,
    version: "unknown",
    startedAt: 1000,
    now: 90_000_000,
  };
  assert.match(statusText(base), /24h unknown/);
  assert.match(statusText(base), /上下文 unknown\/unknown/);
  assert.match(
    statusText({ ...base, lastInboundAt: base.now - 86_400_000 }),
    /24h EXPIRED 超过24h/,
  );
  assert.match(statusText({ ...base, lastInboundAt: base.now + 1 }), /24h unknown/);
  assert.match(
    statusText({ ...base, diagnostics: { contextTokens: 0, contextWindow: 1000 } }),
    /0\/1000 tokens\n占用 0\.0%/,
  );
});

test("last inbound survives restart, excludes duplicates and preserves pre-upgrade receipt time", async (t) => {
  const f = fixture(t);
  assert.equal(f.store.lastInboundAt(), undefined);
  f.input("hello", "same");
  const at = f.store.lastInboundAt()!;
  f.store.set("lastInboundAt", String(at - 100));
  f.input("hello", "same");
  assert.equal(f.store.lastInboundAt(), at - 100);
  f.store.db.prepare("DELETE FROM meta WHERE key='lastInboundAt'").run();
  const reopened = new Store(f.dir);
  try {
    assert.equal(reopened.lastInboundAt(), at);
  } finally {
    reopened.close();
  }
});

test("status receipt bypasses a failed queue without retrying or discarding ordinary replies", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.enqueue("failed-reply", "ordinary must stay paused");
  const old = f.store.delivery()!;
  f.store.db.prepare("UPDATE outbox SET state='failed' WHERE key=?").run(old.key);
  f.input("/status");
  await f.bridge.processNext();
  assert.equal(await f.bridge.deliverNext(), true);
  assert.match(f.weixin.sent[0]!.text, /failed=1/);
  assert.equal(await f.bridge.deliverNext(), false);
  assert.equal(f.store.delivery()?.key, old.key);
  assert.equal(f.store.delivery()?.state, "failed");
  assert.equal(f.pocket.requests.size, 0);
});
