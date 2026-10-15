import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Account } from "./config.ts";
import { privateDirectory } from "./config.ts";
import { splitText, stableId } from "./format.ts";
import type { Incoming } from "./ilink.ts";
import { type Target, TargetSchema } from "./pocket.ts";

const JobSchema = z.object({
  key: z.string(),
  text: z.string(),
  unsupported: z.number(),
  target: z.string().nullable(),
  creating: z.number(),
  attempts: z.number(),
  due: z.number(),
});
export type Job = z.infer<typeof JobSchema>;
const WatchSchema = z.object({
  id: z.number(),
  title: z.string(),
  pip: z.number(),
  cursor: z.number(),
  approval: z.number(),
});
export type Watch = z.infer<typeof WatchSchema>;
const DeliverySchema = z.object({
  key: z.string(),
  text: z.string(),
  conversation: z.number().nullable(),
  attempts: z.number(),
  due: z.number(),
  state: z.string(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export class Store {
  readonly db: DatabaseSync;
  constructor(dir: string) {
    privateDirectory(dir);
    const file = join(dir, "bridge.sqlite");
    this.db = new DatabaseSync(file, { timeout: 5000 });
    chmodSync(file, 0o600);
    const version = z
      .object({ user_version: z.number() })
      .parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw new Error("Unsupported bridge database version");
    }
    this.db.exec(`
      PRAGMA user_version=1;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL, unsupported INTEGER NOT NULL, target TEXT,
        creating INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS watches (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, pip INTEGER NOT NULL,
        cursor INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, text TEXT NOT NULL,
        conversation INTEGER, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, seq);
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(done, seq);
    `);
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? z.object({ value: z.string() }).parse(row).value : undefined;
  }
  set(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  pin(key: string, value: string): void {
    const previous = this.get(key);
    if (previous !== undefined && previous !== value)
      throw new Error(`Stored ${key} does not match; use a separate data directory`);
    this.set(key, value);
  }
  bind(account: Account, pocketUrl: string, userId: string): void {
    this.transaction(() => {
      this.pin("weixinIdentity", JSON.stringify([account.accountId, account.peer]));
      this.pin("pocketIdentity", JSON.stringify([pocketUrl, userId]));
    });
  }
  ingest(account: Account, cursor: string, messages: Incoming[]): void {
    this.transaction(() => {
      for (const msg of messages) {
        if (msg.peer !== account.peer) throw new Error("Cannot store an unpaired sender");
        const key = stableId(account.accountId, msg.peer, msg.messageId);
        const inserted = this.db
          .prepare("INSERT OR IGNORE INTO inbox(key,text,unsupported) VALUES(?,?,?)")
          .run(key, msg.text, Number(msg.unsupported));
        if (Number(inserted.changes) > 0 && msg.contextToken)
          this.set("contextToken", msg.contextToken);
      }
      if (messages.length)
        this.db
          .prepare("UPDATE outbox SET state='pending',attempts=0,due=0 WHERE state='blocked'")
          .run();
      this.set("syncCursor", cursor);
    });
  }
  target(): Target | undefined {
    const raw = this.get("target");
    return raw ? TargetSchema.parse(JSON.parse(raw)) : undefined;
  }
  setTarget(target: Target): void {
    this.set("target", JSON.stringify(target));
  }
  job(): Job | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE done=0 ORDER BY seq LIMIT 1").get();
    return row ? JobSchema.parse(row) : undefined;
  }
  pinJob(key: string, target: Target): void {
    this.db
      .prepare("UPDATE inbox SET target=? WHERE key=? AND target IS NULL")
      .run(JSON.stringify(target), key);
  }
  markCreating(key: string): void {
    this.db.prepare("UPDATE inbox SET creating=1 WHERE key=?").run(key);
  }
  finish(key: string, response?: string, created?: Target): void {
    this.transaction(() => {
      if (created) {
        this.watch(created, 0);
        this.setTarget(created);
      }
      if (response) this.enqueue(`command:${key}`, response);
      this.db.prepare("UPDATE inbox SET done=1,text='' WHERE key=?").run(key);
    });
  }
  retryJob(job: Job): void {
    this.db
      .prepare("UPDATE inbox SET attempts=attempts+1,due=? WHERE key=?")
      .run(Date.now() + Math.min(60_000, 1000 * 2 ** job.attempts), job.key);
  }
  watch(target: Target, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO watches(id,title,pip,cursor) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,pip=excluded.pip,active=1,
      cursor=CASE WHEN watches.active=0 THEN excluded.cursor ELSE watches.cursor END`,
      )
      .run(target.id, target.title, Number(target.pip), cursor);
  }
  watches(): Watch[] {
    return z
      .array(WatchSchema)
      .parse(this.db.prepare("SELECT * FROM watches WHERE active=1 ORDER BY id").all());
  }
  unwatch(id: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE watches SET active=0,approval=0 WHERE id=?").run(id);
      this.db
        .prepare(
          "UPDATE outbox SET state='cancelled',text='' WHERE conversation=? AND state!='sent'",
        )
        .run(id);
    });
  }
  advance(id: number, cursor: number): void {
    this.db.prepare("UPDATE watches SET cursor=MAX(cursor,?) WHERE id=?").run(cursor, id);
  }
  approval(id: number, count: number): void {
    this.db.prepare("UPDATE watches SET approval=? WHERE id=?").run(count, id);
  }
  enqueue(key: string, text: string, conversation?: number): void {
    const chunks = splitText(text);
    chunks.forEach((chunk, index) => {
      this.db
        .prepare("INSERT OR IGNORE INTO outbox(key,text,conversation) VALUES(?,?,?)")
        .run(stableId(key, String(index)), chunk, conversation ?? null);
    });
  }
  delivery(): Delivery | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM outbox WHERE state IN ('pending','blocked','failed') ORDER BY seq LIMIT 1",
      )
      .get();
    return row ? DeliverySchema.parse(row) : undefined;
  }
  sent(key: string): void {
    this.db.prepare("UPDATE outbox SET state='sent',text='' WHERE key=?").run(key);
  }
  deliveryFailed(row: Delivery, blocked: boolean, delay = 0): void {
    this.db
      .prepare("UPDATE outbox SET state=?,attempts=attempts+1,due=? WHERE key=?")
      .run(
        blocked ? "blocked" : row.attempts >= 7 ? "failed" : "pending",
        Date.now() + Math.max(delay, Math.min(300_000, 2000 * 2 ** row.attempts)),
        row.key,
      );
  }
  retryDeliveries(): void {
    this.db
      .prepare(
        "UPDATE outbox SET state='pending',attempts=0,due=0 WHERE state IN ('failed','blocked')",
      )
      .run();
  }
  counts(): { inbox: number; pending: number; blocked: number; failed: number } {
    const count = (sql: string) => z.object({ n: z.number() }).parse(this.db.prepare(sql).get()).n;
    return {
      inbox: count("SELECT COUNT(*) AS n FROM inbox WHERE done=0"),
      pending: count("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'"),
      blocked: count("SELECT COUNT(*) AS n FROM outbox WHERE state='blocked'"),
      failed: count("SELECT COUNT(*) AS n FROM outbox WHERE state='failed'"),
    };
  }
}
