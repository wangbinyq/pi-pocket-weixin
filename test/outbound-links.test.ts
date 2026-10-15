import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { PocketLinks, NO_PUBLIC_LINK } from "../src/pocket-links.ts";
import { fixture, account } from "./helpers.ts";

const api = "http://127.0.0.1:8787";
const publicUrl = "https://public-pocket.example.com";

test("Pocket URLs in prose, Markdown, relative routes and loopback aliases become public without credentials", () => {
  const links = new PocketLinks(api, publicUrl);
  const text = links.rewrite(
    `正文 [会话](${api}/s/12?entry=3&token=secret#entry-3)。\n<http://localhost:8787/s/13>\n/s/14\nhttp://[::1]:8787/api/c/12/image/2/0\nhttps://user:pass@public-pocket.example.com/s/15?access_token=secret#secret\n${api}/login?token=secret`,
  );
  assert.match(text, /\[会话\]\(https:\/\/public-pocket\.example\.com\/s\/12\?entry=3#entry-3\)。/);
  assert.match(text, /https:\/\/public-pocket\.example\.com\/s\/13/);
  assert.match(text, /https:\/\/public-pocket\.example\.com\/s\/14/);
  assert.match(text, /https:\/\/public-pocket\.example\.com\/api\/c\/12\/image\/2\/0/);
  assert.match(text, /登录链接已隐藏/);
  for (const secret of ["127.0.0.1", "localhost", "[::1]", "secret", "user:pass"])
    assert.ok(!text.includes(secret), secret);
  assert.equal(links.rewrite(text), text);
});

test("prose glued to a Pocket link survives the rewrite and a second rewrite changes nothing", () => {
  const links = new PocketLinks(api, publicUrl);
  const raw = `[根因换了](${api}/s/73186):**代码没拆,是微信/iLink 把「图+文」投成了两条独立消息**(日志两次 intake 相隔 1 秒。`;
  const once = links.rewrite(raw);
  assert.equal(
    once,
    `[根因换了](https://public-pocket.example.com/s/73186):**代码没拆,是微信/iLink 把「图+文」投成了两条独立消息**(日志两次 intake 相隔 1 秒。`,
  );
  assert.ok(!once.includes("%"), once);
  assert.equal(links.rewrite(once), once);
  assert.equal(
    links.rewrite(`看 ${api}/s/1中文继续`),
    "看 https://public-pocket.example.com/s/1中文继续",
  );
  assert.equal(links.rewrite(`${publicUrl}/s/1中文`), `${publicUrl}/s/1中文`);
});

test("an ordinary reply is not corrupted by the enqueue and delivery rewrites", async (t) => {
  const f = fixture(t);
  const bridge = new Bridge(
    f.store,
    f.pocket,
    f.weixin,
    account,
    { ...f.config, pocketUrl: api, publicUrl },
    () => {},
  );
  await bridge.initialize();
  const raw = `[根因换了](${api}/s/73186):**代码没拆,是微信/iLink 把「图+文」投成了两条独立消息**。`;
  f.reply(1, 1, raw);
  await bridge.collect();
  while (await bridge.deliverNext()) {}
  const text = f.weixin.sent.map((row) => row.text).join("\n");
  assert.equal(
    text,
    `[根因换了](https://public-pocket.example.com/s/73186):**代码没拆,是微信/iLink 把「图+文」投成了两条独立消息**。`,
  );
});

test("unrelated origins, similar hosts and ports are not rewritten", () => {
  const text =
    "https://example.com/s/1 http://127.0.0.1:9999/s/2 https://public-pocket.example.com.evil.com/s/3 https://pocket.other.com/a?q=/s/4";
  assert.equal(new PocketLinks(api, publicUrl).rewrite(text), text);
});

test("missing POCKET_PUBLIC_URL explicitly disables links instead of falling back to the API", () => {
  const links = new PocketLinks(api);
  assert.equal(links.session(1), NO_PUBLIC_LINK);
  assert.equal(links.rewrite(`[会话](${api}/s/1)`), `[会话](${NO_PUBLIC_LINK})`);
  assert.ok(!links.rewrite("/s/1").includes("/s/1"));
});

test("all outbound paths including ordinary replies, persisted outbox, help and errors use public-link policy", async (t) => {
  const f = fixture(t);
  const bridge = new Bridge(
    f.store,
    f.pocket,
    f.weixin,
    account,
    { ...f.config, pocketUrl: api, publicUrl },
    () => {},
  );
  f.pocket.link = (id) => `${api}/s/${id}`;
  await bridge.initialize();
  f.reply(1, 1, `普通回答：[继续](${api}/s/2?token=canary)`);
  await bridge.collect();
  f.store.db.prepare("INSERT INTO outbox(key,text) VALUES(?,?)").run("legacy", `旧队列 ${api}/s/9`);
  for (const cmd of ["/help", "/status", "/pip", "/unknown"]) {
    f.input(cmd);
    await bridge.processNext();
  }
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 1 }];
  await bridge.collect();
  f.store.enqueue("error", `失败时请打开 ${api}/s/3`);
  while (await bridge.deliverNext()) {}
  const text = f.weixin.sent.map((row) => row.text).join("\n");
  assert.match(text, /普通回答/);
  assert.match(text, /旧队列 https:\/\/public-pocket\.example\.com\/s\/9/);
  assert.match(text, /需要人工审批/);
  assert.match(text, /失败时请打开 https:\/\/public-pocket\.example\.com\/s\/3/);
  assert.ok(!text.includes("127.0.0.1"));
  assert.ok(!text.includes("canary"));
});

test("no-public configuration degrades ordinary and command replies at the shared send boundary", async (t) => {
  const f = fixture(t);
  const bridge = new Bridge(
    f.store,
    f.pocket,
    f.weixin,
    account,
    { ...f.config, pocketUrl: api, publicUrl: undefined },
    () => {},
  );
  f.pocket.link = (id) => `${api}/s/${id}`;
  await bridge.initialize();
  f.reply(1, 1, `看 ${api}/s/2`);
  await bridge.collect();
  f.input("/status");
  await bridge.processNext();
  while (await bridge.deliverNext()) {}
  assert.ok(f.weixin.sent.every((row) => !row.text.includes("127.0.0.1")));
  assert.ok(f.weixin.sent.every((row) => row.text.includes("POCKET_PUBLIC_URL")));
});

test("rewriting happens before splitting so expanded public links keep the 1800 point ceiling", async (t) => {
  const f = fixture(t);
  const bridge = new Bridge(
    f.store,
    f.pocket,
    f.weixin,
    account,
    { ...f.config, pocketUrl: api, publicUrl },
    () => {},
  );
  await bridge.initialize();
  f.reply(1, 1, `看 ${api}/s/1\n`.repeat(100));
  await bridge.collect();
  while (await bridge.deliverNext()) {}
  assert.ok(f.weixin.sent.length > 1);
  assert.ok(f.weixin.sent.every((row) => Array.from(row.text).length <= 1800));
  assert.ok(f.weixin.sent.every((row) => !row.text.includes("127.0.0.1")));
});

test("protocol-relative Pocket links are public but unrelated links stay unchanged", () => {
  const links = new PocketLinks(api, publicUrl);
  assert.equal(
    links.rewrite("看 //127.0.0.1:8787/s/12"),
    "看 https://public-pocket.example.com/s/12",
  );
  assert.equal(links.rewrite("看 //unrelated.example.com/s/12"), "看 //unrelated.example.com/s/12");
  assert.equal(
    links.rewrite("看 http://127.0.0.1:8787/s/12，继续"),
    "看 https://public-pocket.example.com/s/12，继续",
  );
});

test("legacy outbox expansion is re-split with stable identifiers and no oversized sends", async (t) => {
  const f = fixture(t);
  const longPublic =
    "https://" + ["a".repeat(60), "b".repeat(60), "c".repeat(60), "example", "com"].join(".");
  const bridge = new Bridge(
    f.store,
    f.pocket,
    f.weixin,
    account,
    { ...f.config, pocketUrl: api, publicUrl: longPublic },
    () => {},
  );
  await bridge.initialize();
  f.store.db
    .prepare("INSERT INTO outbox(key,text) VALUES(?,?)")
    .run("legacy-long", "a".repeat(1760) + " " + api + "/s/9");
  assert.equal(await bridge.deliverNext(), true);
  assert.equal(f.weixin.sent.length, 2);
  assert.ok(f.weixin.sent.every((row) => Array.from(row.text).length <= 1800));
  assert.ok(f.weixin.sent.every((row) => /^[a-f0-9]{64}$/.test(row.clientId)));
  assert.notEqual(f.weixin.sent[0]!.clientId, f.weixin.sent[1]!.clientId);
  assert.ok(!f.weixin.sent.some((row) => row.text.includes("127.0.0.1")));
});
