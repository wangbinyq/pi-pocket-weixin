import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/store.ts";

test("v2 media migration adds durable payloads without changing routing, cursor or queue identities", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pw-media-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = new DatabaseSync(join(dir, "bridge.sqlite"));
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, text TEXT NOT NULL,
      unsupported INTEGER NOT NULL, target TEXT, creating INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, sealed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE watches (id INTEGER PRIMARY KEY, title TEXT NOT NULL, pip INTEGER NOT NULL, cursor INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, text TEXT NOT NULL, conversation INTEGER, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0);
    INSERT INTO meta VALUES ('target','{"id":1,"title":"PiP","pip":true}'),('syncCursor','unchanged-cursor');
    INSERT INTO watches(id,title,pip,cursor) VALUES(1,'PiP',1,42);
    INSERT INTO inbox(key,text,unsupported) VALUES('inbox-identity','pending task',0);
    INSERT INTO outbox(key,text,conversation) VALUES('outbox-identity','pending reply',1);
    PRAGMA user_version=2;
  `);
  raw.close();
  const store = new Store(dir);
  try {
    assert.equal(
      store.db.prepare("PRAGMA user_version").get()?.user_version,
      3,
      "media schema must advance from v2 to v3",
    );
    assert.equal(store.target()?.id, 1);
    assert.equal(store.watches()[0]?.cursor, 42);
    assert.equal(store.get("syncCursor"), "unchanged-cursor");
    assert.equal(store.job()?.key, "inbox-identity");
    assert.equal(store.job()?.media, null);
    assert.equal(store.job()?.attachments, null);
    assert.equal(store.delivery()?.key, "outbox-identity");
    assert.equal(store.delivery()?.wire, null);
    assert.equal(store.delivery()?.media, null);
  } finally {
    store.close();
  }
});
