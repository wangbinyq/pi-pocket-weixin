import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { Pocket } from "../src/pocket.ts";
import { fixture } from "./helpers.ts";

const publicUrl = "https://public-pocket.example.com";

test("public link configuration is separate from credentialed API traffic", async () => {
  const urls: string[] = [];
  const pocket = new Pocket("http://127.0.0.1:8787", "test-token", {
    publicUrl,
    fetcher: async (url, init) => {
      urls.push(String(url));
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-token");
      return Response.json({ user: { id: "owner", role: "owner" } });
    },
  });
  await pocket.principal();
  assert.equal(pocket.link(12), `${publicUrl}/s/12`);
  assert.deepEqual(urls, ["http://127.0.0.1:8787/api/me"]);
  assert.equal(
    new Pocket("http://127.0.0.1:8787", "test-token").link(12),
    "Pocket 公网链接未配置（请设置 POCKET_PUBLIC_URL 后在网页查看）。",
  );
});

test("commands and approval notifications all use the configured public link origin", async (t) => {
  const f = fixture(t);
  const pocket = new Pocket("http://127.0.0.1:8787", "test-token", { publicUrl });
  f.pocket.link = (id) => pocket.link(id);
  await f.bridge.initialize();
  for (const command of ["/pip", "/status", "/resume 2", "/reset", "/new project"]) {
    f.input(command);
    await f.bridge.processNext();
    while (await f.bridge.deliverNext()) {}
    assert.match(
      f.weixin.sent.at(-1)!.text,
      /\[#\d+\]\(https:\/\/public-pocket\.example\.com\/s\/\d+\)/,
    );
  }
  f.pocket.active = [{ id: f.store.target()!.id, title: "project", busy: true, approvals: 1 }];
  await f.bridge.collect();
  while (await f.bridge.deliverNext()) {}
  assert.match(
    f.weixin.sent.at(-1)!.text,
    /\[#\d+\]\(https:\/\/public-pocket\.example\.com\/s\/\d+\)/,
  );
  assert.ok(
    f.weixin.sent.every(
      (message) => !message.text.includes("127.0.0.1") && !message.text.includes("test-token"),
    ),
  );
  assert.ok(
    f.weixin.sent.every((message) => !/\)\s*\nhttps?:\/\//.test(message.text)),
    "the public link must sit on the session ID, not on its own line",
  );
});

test("loadConfig reads the public origin and rejects credential-bearing or non-origin URLs", () => {
  const previous = process.env;
  try {
    process.env = {
      ...previous,
      POCKET_URL: "http://127.0.0.1:8787",
      POCKET_TOKEN: "test-token",
      POCKET_PUBLIC_URL: publicUrl,
    };
    assert.equal(loadConfig().publicUrl, publicUrl);
    for (const invalid of [
      `${publicUrl}/login?token=secret`,
      `${publicUrl}/subpath`,
      "https://user:secret@public-pocket.example.com",
    ]) {
      process.env.POCKET_PUBLIC_URL = invalid;
      assert.throws(() => loadConfig());
    }
    delete process.env.POCKET_PUBLIC_URL;
    assert.equal(loadConfig().publicUrl, undefined);
  } finally {
    process.env = previous;
  }
});
