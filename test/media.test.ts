import assert from "node:assert/strict";
import { mkdir, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { ILink, ILinkError, incomingFor } from "../src/ilink.ts";
import { MAX_MEDIA, MediaCache, MediaError, readExport, type MediaRef } from "../src/media.ts";
import { Pocket } from "../src/pocket.ts";
import { Store } from "../src/store.ts";
import { aesKey, cdnUrl, decrypt, encrypt } from "../src/weixin-media.ts";
import { account, fixture } from "./helpers.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const ref: MediaRef = {
  kind: "file",
  name: "report.txt",
  query: "query",
  key: Buffer.alloc(16).toString("base64"),
};
const wireImage = {
  type: 2,
  image_item: { media: { encrypt_query_param: "query", aes_key: ref.key } },
};

test("media and quoted media remain untrusted context, with identity, whole-message and count gates", () => {
  const raw = {
    message_id: "1",
    from_user_id: account.peer,
    item_list: [
      {
        type: 1,
        text_item: { text: "/stop" },
        ref_msg: { title: "original", message_item: wireImage },
      },
    ],
  };
  const parsed = incomingFor(raw, account)!;
  assert.equal(parsed.unsupported, false);
  assert.equal(parsed.media?.[0]?.kind, "image");
  assert.equal(parsed.text, "[引用: original]\n/stop");
  assert.equal(incomingFor({ ...raw, from_user_id: "intruder" }, account), undefined);
  assert.equal(incomingFor({ ...raw, room_id: "group" }, account), undefined);
  assert.equal(incomingFor({ ...raw, item_list: [wireImage] }, account)?.unsupported, false);
  assert.equal(
    incomingFor({ ...raw, item_list: Array.from({ length: 9 }, () => wireImage) }, account)
      ?.unsupported,
    true,
  );
  for (const extra of [
    { type: 2, image_item: {} },
    { type: 3, voice_item: { text: "untrusted ASR" } },
    { type: 5 },
  ])
    assert.equal(
      incomingFor({ ...raw, item_list: [...raw.item_list, extra] }, account)?.unsupported,
      true,
    );
});

test("AES keys match raw/base64-hex variants and invalid PKCS7 padding is rejected", () => {
  const key = Buffer.from("0123456789abcdef");
  assert.deepEqual(aesKey(key.toString("base64")), key);
  assert.deepEqual(aesKey(Buffer.from(key.toString("hex")).toString("base64")), key);
  assert.deepEqual(decrypt(encrypt(png, key), key), png);
  assert.throws(() => aesKey("not a key"), MediaError);
  assert.throws(() => aesKey(Buffer.alloc(32, 255).toString("base64")), MediaError);
  assert.throws(() => decrypt(Buffer.alloc(17), key), MediaError);
});

test("CDN fetches are HTTPS allowlisted, redirect-refused, bounded and never carry the bot token", async () => {
  for (const bad of [
    "http://novac2c.cdn.weixin.qq.com/c2c",
    "https://127.0.0.1/x",
    "https://evil.example/x",
    "https://novac2c.cdn.weixin.qq.com.evil.example/x",
    "https://user@novac2c.cdn.weixin.qq.com/x",
    "https://novac2c.cdn.weixin.qq.com:8443/x",
    "invalid",
  ])
    assert.throws(() => cdnUrl(bad), MediaError);
  const key = Buffer.alloc(16);
  const api = new ILink(account, async (url, init) => {
    assert.equal(
      String(url),
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=query",
    );
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    return new Response(new Uint8Array(encrypt(png, key)));
  });
  assert.deepEqual(await api.download({ ...ref, kind: "image" }), png);
  const expired = new ILink(account, async () => new Response(null, { status: 404 }));
  await assert.rejects(expired.download(ref), /已过期/);
  const over = new ILink(
    account,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(1024 * 1024));
          },
        }),
      ),
  );
  await assert.rejects(over.download(ref), /超过 20 MiB/);
});

for (const kind of ["image", "file"] as const) {
  test(`${kind} upload uses encrypted POST, base64(hex-key), native media fields and a stable client ID`, async (t) => {
    const f = fixture(t);
    const blob = await f.bridge.media.put(
      kind === "image" ? png : Buffer.from("report"),
      kind === "image" ? "image.png" : "report.txt",
      kind,
    );
    let key: Buffer | undefined;
    let encrypted = Buffer.alloc(0);
    const calls: string[] = [];
    const api = new ILink(account, async (url, init) => {
      const path = new URL(String(url));
      calls.push(path.pathname);
      assert.equal(init?.redirect, "error");
      if (path.pathname.endsWith("getuploadurl")) {
        const body = JSON.parse(String(init?.body)) as {
          aeskey: string;
          media_type: number;
          rawsize: number;
          filesize: number;
        };
        key = Buffer.from(body.aeskey, "hex");
        assert.equal(body.media_type, kind === "image" ? 1 : 3);
        assert.equal(body.rawsize, blob.size);
        assert.equal(body.filesize % 16, 0);
        return Response.json({ upload_param: "upload-query" });
      }
      if (path.hostname === "novac2c.cdn.weixin.qq.com") {
        assert.equal(init?.method, "POST");
        assert.equal(new Headers(init.headers).get("Authorization"), null);
        assert.ok(init.body instanceof Uint8Array);
        encrypted = Buffer.from(init.body);
        return new Response("", { headers: { "x-encrypted-param": "download-query" } });
      }
      const body = JSON.parse(String(init?.body)) as {
        msg: { client_id: string; item_list: { type: number }[] };
      };
      assert.equal(body.msg.client_id, "stable-client-id");
      assert.equal(body.msg.item_list[0]?.type, kind === "image" ? 2 : 4);
      return Response.json({ ret: 0 });
    });
    const original = await f.bridge.media.read(blob);
    const item = await api.upload(account.peer, blob, original);
    assert.ok(key);
    assert.deepEqual(decrypt(encrypted, key), original);
    const media = item.type === 2 ? item.image_item.media : item.file_item.media;
    assert.deepEqual(aesKey(media.aes_key), key);
    assert.equal(Buffer.from(media.aes_key, "base64").length, 32);
    await api.sendMedia(account.peer, item, "stable-client-id", "context");
    assert.deepEqual(calls, ["/ilink/bot/getuploadurl", "/c2c/upload", "/ilink/bot/sendmessage"]);
  });
}

test("an untrusted upload_full_url is refused without sending bytes or credentials to it", async (t) => {
  const f = fixture(t);
  const blob = await f.bridge.media.put(png, "image.png", "image");
  let calls = 0;
  const api = new ILink(account, async () => {
    calls++;
    return Response.json({ upload_full_url: "https://evil.example/upload" });
  });
  await assert.rejects(api.upload(account.peer, blob, png), MediaError);
  assert.equal(calls, 1);
});

test("incoming attachments pin route and persist uploaded references across submit loss and restart", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.ingest(account, "media-cursor", [
    {
      messageId: "media-1",
      peer: account.peer,
      text: "read report",
      unsupported: false,
      media: [ref],
    },
  ]);
  f.pocket.failSubmit = true;
  await f.bridge.processNext();
  const key = f.store.job()!.key;
  const attachments = f.store.job()!.attachments;
  assert.ok(attachments);
  f.store.select({ id: 2, title: "other", pip: false }, 0);
  f.store.db.exec("UPDATE inbox SET due=0");
  f.pocket.failSubmit = false;
  const reopened = new Store(f.dir);
  try {
    const bridge = new Bridge(reopened, f.pocket, f.weixin, account, f.config, () => {});
    await bridge.initialize();
    await bridge.processNext();
    assert.equal(f.weixin.downloads.length, 1);
    assert.equal(f.pocket.uploads.length, 1);
    assert.equal(f.pocket.requests.get(key)?.id, 1);
    assert.deepEqual(f.pocket.submittedAttachments[0], f.pocket.submittedAttachments[1]);
    assert.equal(reopened.job(), undefined);
    assert.equal(
      reopened.db.prepare("SELECT media,attachments FROM inbox WHERE key=?").get(key)?.media,
      null,
    );
  } finally {
    reopened.close();
  }
});

test("a partial attachment failure never submits text alone or repeats already-saved uploads", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.ingest(account, "cursor", [
    {
      messageId: "media-2",
      peer: account.peer,
      text: "compare",
      unsupported: false,
      media: [ref, { ...ref, query: "second" }],
    },
  ]);
  const download = f.weixin.download.bind(f.weixin);
  f.weixin.download = async (r) => {
    if (r.query === "second") throw new Error("network failed");
    return download(r);
  };
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 0);
  assert.equal(f.pocket.uploads.length, 1);
  f.weixin.download = download;
  f.store.db.exec("UPDATE inbox SET due=0");
  await f.bridge.processNext();
  assert.equal(f.pocket.uploads.length, 2);
  assert.equal(f.pocket.submittedAttachments[0]?.length, 2);
});

test("invalid image, quoted video and commands with attachments reject the entire request", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.ingest(account, "cursor", [
    {
      messageId: "invalid-image",
      peer: account.peer,
      text: "look",
      unsupported: false,
      media: [{ ...ref, kind: "image" }],
    },
  ]);
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 0);
  assert.equal(f.pocket.uploads.length, 0);
  f.store.ingest(account, "next", [
    {
      messageId: "attachment-command",
      peer: account.peer,
      text: "/reset",
      unsupported: false,
      media: [ref],
    },
  ]);
  await f.bridge.processNext();
  assert.equal(f.pocket.resets.length, 0);
});

test("media boundaries never merge with neighboring ordinary text", async (t) => {
  const f = fixture(t);
  f.config.textBatchDelayMs = 300;
  await f.bridge.initialize();
  f.input("before");
  f.store.ingest(account, "media", [
    { messageId: "file", peer: account.peer, text: "", unsupported: false, media: [ref] },
  ]);
  f.input("after");
  await f.bridge.processNext();
  await f.bridge.processNext();
  assert.deepEqual(
    [...f.pocket.requests.values()].map((r) => r.text),
    ["before", ""],
  );
  assert.equal(f.store.job()?.text, "after");
});

test("/send snapshots only an explicit local project file and reuses encrypted upload across restart", async (t) => {
  const f = fixture(t);
  f.config.pocketUrl = "http://127.0.0.1:8787";
  f.pocket.directory = join(fixture(t).dir, "project");
  await mkdir(f.pocket.directory);
  await writeFile(join(f.pocket.directory, "report.txt"), "original");
  await f.bridge.initialize();
  f.input("/resume 2");
  await f.bridge.processNext();
  while (await f.bridge.deliverNext()) {}
  f.input("/send report.txt");
  await f.bridge.processNext();
  assert.match(f.store.delivery()?.text || "", /已排队发送/);
  await f.bridge.deliverNext();
  const key = f.store.delivery()!.key;
  await writeFile(join(f.pocket.directory, "report.txt"), "changed");
  f.weixin.fail = new Error("send response lost");
  await f.bridge.deliverNext();
  assert.equal(f.weixin.uploaded.length, 1);
  assert.ok(f.store.delivery()?.wire);
  f.weixin.fail = undefined;
  f.store.db.exec("UPDATE outbox SET due=0");
  const reopened = new Store(f.dir);
  try {
    const bridge = new Bridge(reopened, f.pocket, f.weixin, account, f.config, () => {});
    await bridge.initialize();
    const blob = JSON.parse(reopened.delivery()!.media!) as Parameters<MediaCache["read"]>[0];
    assert.equal((await bridge.media.read(blob)).toString(), "original");
    assert.ok(await bridge.deliverNext());
    assert.equal(f.weixin.uploaded.length, 1);
    assert.equal(f.weixin.mediaSent[0]?.clientId, key);
    assert.equal(reopened.delivery(), undefined);
  } finally {
    reopened.close();
  }
});

test("switching while media upload is in flight cancels send and cannot revive the old reply", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  const blob = await f.bridge.media.put(png, "image.png", "image");
  f.store.enqueueMedia("image", blob, 1);
  const upload = f.weixin.upload.bind(f.weixin);
  f.weixin.upload = async (peer, file) => {
    f.store.select({ id: 2, title: "other", pip: false }, 0);
    return upload(peer, file);
  };
  assert.equal(await f.bridge.deliverNext(), false);
  assert.equal(f.weixin.mediaSent.length, 0);
  f.store.retryDeliveries();
  assert.equal(f.store.delivery(), undefined);
});

test("media stale context retries once using the same upload and client id", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/help");
  await f.bridge.processNext();
  while (await f.bridge.deliverNext()) {}
  const blob = await f.bridge.media.put(png, "image.png", "image");
  f.store.enqueueMedia("stale-image", blob, 1);
  const contexts: (string | undefined)[] = [];
  const send = f.weixin.sendMedia.bind(f.weixin);
  f.weixin.sendMedia = async (peer, item, id, context) => {
    contexts.push(context);
    if (context) throw new ILinkError(-2, undefined, "prepare failed");
    await send(peer, item, id, context);
  };
  await f.bridge.deliverNext();
  assert.deepEqual(contexts, ["test-context", undefined]);
  assert.equal(f.weixin.uploaded.length, 1);
  assert.equal(f.weixin.mediaSent.length, 1);
});

test("export refuses traversal, symlink escape, secrets, bridge data, directories and oversized files", async (t) => {
  const f = fixture(t);
  const project = join(f.dir, "project");
  const state = join(f.dir, "state");
  await mkdir(project);
  await mkdir(state);
  await writeFile(join(project, "ok.txt"), "public artifact");
  await writeFile(join(f.dir, "outside.txt"), "outside");
  await writeFile(join(project, ".env"), "secret");
  await symlink(join(f.dir, "outside.txt"), join(project, "escape.txt"));
  await symlink(join(project, "ok.txt"), join(project, "credentials.json"));
  await symlink(state, join(project, "state"));
  await writeFile(join(state, "info.txt"), "private");
  await writeFile(join(project, "too-big"), "");
  await truncate(join(project, "too-big"), MAX_MEDIA + 1);
  for (const path of [
    "../outside.txt",
    "escape.txt",
    ".env",
    "credentials.json",
    "state/info.txt",
    ".",
    "too-big",
  ])
    await assert.rejects(readExport(project, path, state), MediaError);
  assert.equal((await readExport(project, "ok.txt", state)).data.toString(), "public artifact");
  const cache = new MediaCache(state);
  const blob = await cache.put(png, "../image.png", "image");
  assert.equal(blob.name, "image.png");
  assert.equal((await stat(join(cache.dir, blob.id))).mode & 0o777, 0o600);
  assert.equal((await stat(cache.dir)).mode & 0o777, 0o700);
  await assert.rejects(cache.read({ ...blob, id: "../outside.txt" }));
  await writeFile(join(cache.dir, blob.id), "corrupted");
  await assert.rejects(cache.read(blob), /校验失败/);
});

test("cache cleanup keeps pending media and only expires old unreferenced snapshots", async (t) => {
  const f = fixture(t);
  const a = await f.bridge.media.put(png, "a.png", "image");
  const b = await f.bridge.media.put(Buffer.from("old report"), "b.txt", "file");
  const ancient = new Date(Date.now() - 8 * 86_400_000);
  await utimes(join(f.bridge.media.dir, a.id), ancient, ancient);
  await utimes(join(f.bridge.media.dir, b.id), ancient, ancient);
  await f.bridge.media.prune(new Set([a.id]));
  assert.deepEqual(await f.bridge.media.read(a), png);
  await assert.rejects(f.bridge.media.read(b), /ENOENT/);
});

test("Pocket uploads use binary authenticated API and returned attachment metadata", async () => {
  const pocket = new Pocket("https://pocket.example.com", "token", {
    fetcher: async (url, init) => {
      assert.equal(String(url), "https://pocket.example.com/api/c/2/upload?name=image.png");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("X-Pocket"), "1");
      assert.ok(init?.body instanceof Uint8Array);
      assert.deepEqual(Buffer.from(init.body), png);
      return Response.json({
        path: "/uploads/2/image.png",
        name: "image.png",
        mime: "image/png",
        size: png.length,
      });
    },
  });
  const uploaded = await pocket.upload(2, png, "image.png", "image/png");
  assert.equal(uploaded.path, "/uploads/2/image.png");
  await assert.rejects(pocket.cwd({ id: 1, title: "PiP", pip: true }), /PiP 不导出/);
});

test("/send rejects remote filesystem access and never exports a path mentioned in a model reply", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("/send /etc/passwd");
  await f.bridge.processNext();
  assert.match(f.store.delivery()?.text || "", /loopback/);
  f.reply(1, 10, "![image](/etc/passwd)\nMEDIA:/etc/passwd");
  await f.bridge.collect();
  while (await f.bridge.deliverNext()) {}
  assert.equal(f.weixin.uploaded.length, 0);
  assert.equal(f.weixin.mediaSent.length, 0);
});
