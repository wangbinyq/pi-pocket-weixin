import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAccount, saveAccount } from "../src/config.ts";
import { splitText, stableId } from "../src/format.ts";
import { HttpError, ilinkBase, pocketBase, requestJson, type Fetcher } from "../src/http.ts";
import { ILink, incomingFor, qrLogin } from "../src/ilink.ts";
import { finalText, Pocket } from "../src/pocket.ts";
import { account, fixture } from "./helpers.ts";

test("iLink headers, cursor and outgoing protocol match the reference adapter", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json(
      String(url).endsWith("getupdates")
        ? { ret: 0, msgs: [], get_updates_buf: "next", longpolling_timeout_ms: 35000 }
        : { ret: 0 },
    );
  };
  const api = new ILink(account, fetcher);
  assert.equal((await api.updates("cursor")).cursor, "next");
  await api.send(account.peer, "hello", "stable-id", "context");
  const poll = calls[0]!;
  assert.equal(poll.url, "https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
  const headers = new Headers(poll.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-token");
  assert.equal(headers.get("AuthorizationType"), "ilink_bot_token");
  assert.equal(headers.get("iLink-App-ClientVersion"), "131584");
  assert.equal(poll.init.redirect, "error");
  const body: unknown = JSON.parse(String(calls[1]!.init.body));
  assert.deepEqual(body, {
    msg: {
      from_user_id: "",
      to_user_id: account.peer,
      client_id: "stable-id",
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: "hello" } }],
      context_token: "context",
    },
    base_info: { channel_version: "2.2.0" },
  });
});

test("QR renders the liteapp URL, not the opaque token; binds returned owner", async () => {
  const displayed: string[] = [];
  const api: Fetcher = async (url) =>
    Response.json(
      String(url).includes("get_bot_qrcode")
        ? { qrcode: "opaque", qrcode_img_content: "https://weixin.qq.com/liteapp-qr" }
        : {
            status: "confirmed",
            ilink_bot_id: "test-bot",
            bot_token: "test-token",
            baseurl: account.baseUrl,
            ilink_user_id: account.peer,
          },
    );
  const result = await qrLogin(
    async (url) => {
      displayed.push(url);
    },
    undefined,
    api,
  );
  assert.deepEqual(result, account);
  assert.deepEqual(displayed, ["https://weixin.qq.com/liteapp-qr"]);
});

test("QR refuses untrusted redirect hosts and missing owner identities", async () => {
  const qr = { qrcode: "opaque", qrcode_img_content: "https://weixin.qq.com/qr" };
  const redirect: Fetcher = async (url) =>
    Response.json(
      String(url).includes("get_bot_qrcode")
        ? qr
        : { status: "scaned_but_redirect", redirect_host: "attacker.example" },
    );
  await assert.rejects(
    qrLogin(async () => {}, undefined, redirect),
    /Untrusted/,
  );
  const missing: Fetcher = async (url) =>
    Response.json(
      String(url).includes("get_bot_qrcode")
        ? qr
        : { status: "confirmed", ilink_bot_id: "id", bot_token: "token" },
    );
  await assert.rejects(
    qrLogin(async () => {}, undefined, missing),
    /identity/,
  );
});

test("credential and SQLite files are private, conflicting account cannot overwrite", (t) => {
  const f = fixture(t);
  saveAccount(f.dir, account);
  assert.deepEqual(loadAccount(f.dir), account);
  assert.equal(statSync(join(f.dir, "credentials.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dir, "bridge.sqlite")).mode & 0o777, 0o600);
  assert.throws(() => saveAccount(f.dir, { ...account, peer: "other" }));
  assert.match(readFileSync(join(f.dir, "credentials.json"), "utf8"), /test-owner/);
});

test("SSRF and credential redirects are refused", async () => {
  for (const url of [
    "http://ilinkai.weixin.qq.com",
    "https://weixin.qq.com.evil.test",
    "https://attacker.example",
    "https://u:p@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com/?token=x",
  ])
    assert.throws(() => ilinkBase(url));
  assert.throws(() => pocketBase("http://192.168.1.10:8080"));
  assert.throws(() => pocketBase("https://pocket.example.com/login?token=secret"));
  assert.equal(pocketBase("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  await assert.rejects(
    requestJson(
      async (_url, init) => {
        assert.equal(init?.redirect, "error");
        return new Response("", { status: 302 });
      },
      "https://pocket.example.com",
      {},
      1000,
    ),
    HttpError,
  );
});

test("Pocket checks owner auth and sends an idempotent queued submission", async () => {
  const calls: RequestInit[] = [];
  const fetcher: Fetcher = async (url, init = {}) => {
    calls.push(init);
    if (String(url).endsWith("/me")) return Response.json({ user: { id: "owner", role: "owner" } });
    return Response.json({ submissionId: 1, requestId: "u:owner:stable" });
  };
  const pocket = new Pocket("https://pocket.example.com", "test-token", { fetcher });
  assert.equal(await pocket.principal(), "owner");
  await pocket.submit(12, "task", "stable");
  assert.equal(new Headers(calls[1]!.headers).get("X-Pocket"), "1");
  assert.deepEqual(JSON.parse(String(calls[1]!.body)), {
    text: "task",
    requestId: "stable",
    mode: "followUp",
  });
  const viewer = new Pocket("https://pocket.example.com", "test-token", {
    fetcher: async () => Response.json({ user: { id: "viewer", role: "viewer" } }),
  });
  await assert.rejects(viewer.principal(), /owner/);
});

test("history catch-up paginates without skipping more than one page", async () => {
  const entries = Array.from({ length: 1100 }, (_, index) => ({ id: index + 1, kind: "user" }));
  const pocket = new Pocket("https://pocket.example.com", "test-token", {
    fetcher: async (url) => {
      const before = Number(new URL(String(url)).searchParams.get("before") || 99999);
      return Response.json(entries.filter((entry) => entry.id < before).slice(-400));
    },
  });
  const got = await pocket.after(1, 50);
  assert.equal(got.length, 1050);
  assert.equal(got[0]?.id, 51);
  assert.equal(got.at(-1)?.id, 1100);
});

test("unsupported media is not silently executed as a partial text request", () => {
  const event = incomingFor(
    {
      message_id: 7,
      from_user_id: account.peer,
      item_list: [{ type: 1, text_item: { text: "use this file" } }, { type: 4 }],
    },
    account,
  );
  assert.equal(event?.messageId, "7");
  assert.equal(event?.unsupported, true);
  assert.equal(incomingFor({ from_user_id: account.peer }, account), undefined);
});

test("chunking preserves Unicode and respects the conservative 2000-character ceiling", () => {
  const source = "你好🙂".repeat(1900);
  const chunks = splitText(source);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 1800));
  assert.equal(stableId("a", "bc"), stableId("a", "bc"));
  assert.notEqual(stableId("a", "bc"), stableId("ab", "c"));
});

test("only final text is exported, errors do not leak tool logs", () => {
  assert.equal(
    finalText({
      id: 1,
      kind: "assistant",
      blocks: [
        { type: "thinking", text: "secret" },
        { type: "text", text: "answer" },
      ],
      stopReason: "stop",
    }),
    "answer",
  );
  assert.equal(finalText({ id: 2, kind: "toolResult", error: "tool secret" }), undefined);
  assert.equal(
    finalText({ id: 3, kind: "assistant", error: "provider secret", stopReason: "error" }),
    "任务失败，请在 Pocket 查看详情。",
  );
});
