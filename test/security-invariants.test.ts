// Executable twin of SECURITY.md. Every test names the boundary it guards.
// Relaxing one of these is a human decision: update SECURITY.md in the same change.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { saveAccount } from "../src/config.ts";
import { ilinkBase, pocketBase, requestJson } from "../src/http.ts";
import { incomingFor, qrLogin } from "../src/ilink.ts";
import { Pocket } from "../src/pocket.ts";
import { Store } from "../src/store.ts";
import { stableId } from "../src/format.ts";
import { FakePocket, FakeWeixin, account, fixture } from "./helpers.ts";

const message = (over: Record<string, unknown> = {}) => ({
  message_id: "1",
  from_user_id: account.peer,
  item_list: [{ type: 1, text_item: { text: "hello" } }],
  ...over,
});

test("SEC-1: only the peer returned by QR login clears the inbound gate", () => {
  assert.ok(incomingFor(message(), account));
  for (const rejected of [
    message({ from_user_id: "someone-else" }),
    message({ from_user_id: account.accountId }),
    message({ room_id: "room-1" }),
    message({ chat_room_id: "room-1" }),
    message({ to_user_id: "another-bot" }),
    message({ message_type: 2 }),
    { message_id: "1", item_list: [] },
    { from_user_id: account.peer, item_list: [] },
  ])
    assert.equal(incomingFor(rejected, account), undefined);
});

test("SEC-1: the store refuses to persist a sender this account is not paired with", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.store.ingest(account, "cursor-1", [
        { messageId: "9", peer: "intruder", text: "hello", unsupported: false },
      ]),
    /unpaired sender/,
  );
  assert.equal(f.store.job(), undefined);
});

test("SEC-1: QR login refuses to bind a bot that omitted any identity", async () => {
  const queue: Record<string, unknown>[] = [
    { qrcode: "qr", qrcode_img_content: "https://liteapp.weixin.qq.com/q/qr" },
    { status: "confirmed", ilink_bot_id: "bot-1", bot_token: "token-1" },
  ];
  await assert.rejects(
    qrLogin(
      async () => {},
      undefined,
      async () => Response.json(queue.shift()),
    ),
    /refusing an unbound bot/,
  );
});

test("SEC-2: owner auth is checked at startup and again before input, collection and sending", async (t) => {
  const f = fixture(t);
  let checks = 0;
  const inner = f.pocket.principal.bind(f.pocket);
  f.pocket.principal = async () => {
    checks++;
    return inner();
  };
  await f.bridge.initialize();
  assert.ok(checks >= 1, "startup");
  f.input("hello");
  await f.bridge.processNext();
  assert.ok(checks >= 2, "before submitting input");
  await f.bridge.collect();
  assert.ok(checks >= 3, "before collecting replies");
  f.reply(1, 1, "answer");
  await f.bridge.collect();
  while (await f.bridge.deliverNext()) {}
  assert.ok(checks >= 4, "before sending a reply");
});

test("SEC-2: a changed Pocket principal stops input and collection instead of acting as the new user", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.user = "someone-else";
  f.input("hello");
  await f.bridge.processNext();
  assert.equal(f.pocket.calls.length, 0);
  await assert.rejects(f.bridge.collect(), /identity changed/);
});

const POCKET_ENDPOINTS = [
  "GET /api/c/{id}/history",
  "GET /api/me",
  "GET /api/running",
  "GET /api/sessions",
  "POST /api/c/{id}/abort",
  "POST /api/c/{id}/configure",
  "POST /api/c/{id}/reset",
  "POST /api/c/{id}/submit",
  "POST /api/c/{id}/upload",
  "POST /api/pip",
  "POST /api/sessions",
].sort();
const POCKET_METHODS = [
  "after",
  "create",
  "cwd",
  "head",
  "link",
  "model",
  "models",
  "pip",
  "principal",
  "reset",
  "running",
  "sessions",
  "stop",
  "submit",
  "upload",
].sort();

test("SEC-3: the bridge reaches only the reviewed Pocket endpoints", async () => {
  const calls = new Set<string>();
  let history = 0;
  const pocket = new Pocket("http://127.0.0.1:8787", "token", {
    fetcher: async (url, init) => {
      const path = new URL(String(url)).pathname.replace(/\/\d+(?=\/|$)/g, "/{id}");
      const method = init?.method || "GET";
      calls.add(`${method} ${path}`);
      if (path === "/api/me")
        return Response.json({
          user: { id: "owner", role: "owner" },
          models: [{ provider: "p", id: "m", name: "M", levels: ["off"], images: false }],
        });
      if (path === "/api/sessions" && method === "GET")
        return Response.json([{ id: 7, cwd: "/tmp", busy: false, waiting: false }]);
      if (path === "/api/sessions") return Response.json({ id: 8 });
      if (path === "/api/pip") return Response.json({ pip: { id: 7 } });
      if (path === "/api/running") return Response.json([]);
      if (path === "/api/c/{id}/history")
        return Response.json(history++ === 0 ? [{ id: 3, kind: "assistant", blocks: [] }] : []);
      if (path === "/api/c/{id}/submit") return Response.json({ submissionId: 1, requestId: "r" });
      if (path === "/api/c/{id}/upload")
        return Response.json({
          path: "/uploads/7/test.txt",
          name: "test.txt",
          mime: "text/plain",
          size: 4,
        });
      return Response.json({ ok: true });
    },
  });
  await pocket.principal();
  await pocket.sessions();
  await pocket.pip();
  await pocket.head(7);
  await pocket.after(7, 0);
  await pocket.create("title");
  await pocket.submit(7, "text", "request-id");
  await pocket.stop(7);
  await pocket.models();
  await pocket.model(7, "p", "m");
  await pocket.reset(7);
  await pocket.running();
  await pocket.upload(7, Buffer.from("test"), "test.txt", "text/plain");
  assert.equal(await pocket.cwd({ id: 7, title: "test", pip: false }), "/tmp");
  assert.deepEqual([...calls].sort(), POCKET_ENDPOINTS);
  assert.deepEqual(
    Object.getOwnPropertyNames(Pocket.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    POCKET_METHODS,
  );
});

test("SEC-4: no approval, shell or history-deletion command is reachable from Weixin", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  for (const text of ["/approve", "/approval", "/exec", "/shell", "/delete", "/history", "/yolo"]) {
    f.input(text);
    await f.bridge.processNext();
  }
  assert.equal(f.pocket.calls.length, 0);
  assert.equal(f.pocket.stops.length, 0);
  assert.equal(f.pocket.resets.length, 0);
  assert.equal(f.pocket.modelChanges.length, 0);
});

test("SEC-6: a quoted command is model context, and malformed quoted media rejects the whole message", () => {
  const media = incomingFor(
    message({
      item_list: [
        {
          type: 1,
          text_item: { text: "看这个" },
          ref_msg: { title: "quote", message_item: { type: 2, image_item: {} } },
        },
      ],
    }),
    account,
  );
  assert.ok(media?.unsupported);
  const command = incomingFor(
    message({
      item_list: [
        {
          type: 1,
          text_item: { text: "/resume 2" },
          ref_msg: {
            title: "quote",
            message_item: { type: 1, text_item: { text: "/new secret" } },
          },
        },
      ],
    }),
    account,
  );
  assert.equal(command?.unsupported, false);
  assert.match(command!.text, /^\[引用: quote \| \/new secret\]\n\/resume 2$/);
});

test("SEC-7: Pocket URLs are HTTPS except the four loopback HTTP origins", () => {
  for (const ok of [
    "https://pocket.example.com",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://127.0.0.2:8787",
    "http://[::1]:8787",
  ])
    assert.ok(pocketBase(ok).startsWith("http"));
  for (const bad of [
    "http://pocket.example.com",
    "http://10.0.0.5:8787",
    "http://192.168.1.5:8787",
    "http://127.0.0.3:8787",
    "https://pocket.example.com/login",
    "https://pocket.example.com?token=secret",
    "https://owner:secret@pocket.example.com",
  ])
    assert.throws(() => pocketBase(bad));
});

test("SEC-7: iLink accepts only HTTPS origins beneath weixin.qq.com", () => {
  for (const ok of ["https://ilinkai.weixin.qq.com", "https://anything.weixin.qq.com"])
    assert.equal(ilinkBase(ok), ok);
  for (const bad of [
    "http://ilinkai.weixin.qq.com",
    "https://evil-weixin.qq.com",
    "https://weixin.qq.com.evil.com",
    "https://ilinkai.weixin.qq.com:8443",
    "https://ilinkai.weixin.qq.com/redirect",
    "https://owner@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com?next=evil",
  ])
    assert.throws(() => ilinkBase(bad), /Untrusted iLink/);
});

test("SEC-7: credentialed requests refuse a redirect instead of following it", async () => {
  let redirect: RequestInfo | string | undefined;
  await requestJson(
    async (_url, init) => {
      redirect = init?.redirect;
      return Response.json({});
    },
    "https://pocket.example.com/api/me",
    { headers: { Authorization: "Bearer secret" } },
    1000,
  );
  assert.equal(redirect, "error");
});

test("SEC-7: a QR login redirect to a non-weixin host is refused", async () => {
  const queue: Record<string, unknown>[] = [
    { qrcode: "qr", qrcode_img_content: "https://liteapp.weixin.qq.com/q/qr" },
    { status: "scaned_but_redirect", redirect_host: "evil.com" },
  ];
  await assert.rejects(
    qrLogin(
      async () => {},
      undefined,
      async () => Response.json(queue.shift()),
    ),
    /Untrusted iLink/,
  );
});

test("SEC-8: the data directory, credentials and database are private to the owner", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pw-sec-modes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  saveAccount(dir, { ...account, token: "secret-bot-token" });
  const mode = (path: string) => statSync(path).mode & 0o777;
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, "credentials.json")), 0o600);
  assert.equal(mode(join(dir, "bridge.sqlite")), 0o600);
  store.close();
});

test("SEC-DB: a database from a newer bridge is refused rather than migrated blindly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pw-sec-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  new Store(dir).close();
  const raw = new DatabaseSync(join(dir, "bridge.sqlite"));
  raw.exec("PRAGMA user_version=4;");
  raw.close();
  assert.throws(() => new Store(dir), /Unsupported bridge database version/);
});

test("SEC-10: the Pocket dedup key comes only from bot, peer and Weixin message id", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("继续", "77");
  await f.bridge.processNext();
  assert.deepEqual(f.pocket.calls, [stableId(account.accountId, account.peer, "77")]);
  assert.match(f.pocket.calls[0]!, /^[0-9a-f]{64}$/);
});

test("SEC-CAP: an oversized HTTP body is refused instead of buffered", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(chunk) });
  await assert.rejects(
    requestJson(async () => new Response(stream), "https://pocket.example.com/api/me", {}, 5000),
    /exceeds size limit/,
  );
});

test("SEC-CAP: oversized Weixin text is refused whole, not silently truncated", () => {
  const big = incomingFor(
    message({ item_list: [{ type: 1, text_item: { text: "a".repeat(32_001) } }] }),
    account,
  );
  assert.ok(big?.unsupported);
});

test("SEC-TITLE: a session title cannot smuggle control or bidi characters into Weixin", async (t) => {
  const f = fixture(t);
  const hostile = "ok\u202e\u001b[31m\u0007evil\u2066";
  f.pocket.sessions = async () => [
    { id: 2, title: hostile, cwd: "/tmp", busy: false, waiting: false },
  ];
  await f.bridge.initialize();
  f.input("/sessions");
  await f.bridge.processNext();
  while (await f.bridge.deliverNext()) {}
  const text = f.weixin.sent.map((entry) => entry.text).join("\n");
  assert.match(text, /ok/);
  for (const smuggled of ["\u202e", "\u001b", "\u0007", "\u2066"])
    assert.ok(!text.includes(smuggled), `title smuggled ${JSON.stringify(smuggled)}`);
});

test("SEC-LOG: logs carry no message bodies, model output, tokens or raw errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pw-sec-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const pocket = new FakePocket();
  const weixin = new FakeWeixin();
  const lines: string[] = [];
  const bridge = new Bridge(
    store,
    pocket,
    weixin,
    account,
    {
      dataDir: dir,
      pocketUrl: "https://pocket.example.com",
      pocketToken: "pocket-token-canary",
      publicUrl: "https://pocket.example.com",
      textBatchDelayMs: 0,
    },
    (message) => lines.push(message),
  );
  await bridge.initialize();
  const canary = "body-canary-9f3";
  weixin.batch = {
    cursor: "cursor-1",
    messages: [
      {
        message_id: "1",
        from_user_id: account.peer,
        context_token: "context-canary",
        item_list: [{ type: 1, text_item: { text: canary } }],
      },
    ],
  };
  await bridge.receive();
  pocket.failSubmit = true;
  await bridge.processNext();
  pocket.failSubmit = false;
  pocket.rows.get(1)!.push({
    id: 1,
    kind: "assistant",
    blocks: [{ type: "text", text: `model-${canary}` }],
    stopReason: "stop",
  });
  await bridge.collect();
  weixin.fail = new Error(`send-${canary}`);
  await bridge.deliverNext();
  assert.ok(lines.length >= 3, "the failure paths did log something");
  for (const line of lines)
    for (const secret of [
      canary,
      "pocket-token-canary",
      "context-canary",
      "test-token",
      "test-pocket-token",
    ])
      assert.ok(!line.includes(secret), `log leaked ${JSON.stringify(line)}`);
  store.close();
});
