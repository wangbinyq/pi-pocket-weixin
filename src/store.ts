import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Account } from "./config.ts";
import { privateDirectory } from "./config.ts";
import { splitText, stableId } from "./format.ts";
import type { Incoming } from "./ilink.ts";
import { type Target, TargetSchema } from "./pocket.ts";
import { BlobSchema, type MediaBlob, type Attachment } from "./media.ts";

const JobSchema = z.object({
  key: z.string(),
  text: z.string(),
  unsupported: z.number(),
  media: z.string().nullable(),
  attachments: z.string().nullable(),
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
  media: z.string().nullable(),
  wire: z.string().nullable(),
  attempts: z.number(),
  due: z.number(),
  state: z.string(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export class Store {
  readonly db: DatabaseSync;
  outboundText: (text: string) => string = (text) => text;
  constructor(dir: string) {
    privateDirectory(dir);
    const file = join(dir, "bridge.sqlite");
    this.db = new DatabaseSync(file, { timeout: 5000 });
    chmodSync(file, 0o600);
    const version = z
      .object({ user_version: z.number() })
      .parse(this.db.prepare("PRAGMA user_version").get()).user_version;
    if (![0, 1, 2, 3].includes(version)) {
      this.db.close();
      throw new Error("Unsupported bridge database version");
    }
    this.db.exec(`
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
    if (version < 2)
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE inbox ADD COLUMN received INTEGER NOT NULL DEFAULT 0;" +
            "ALTER TABLE inbox ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0;" +
            "PRAGMA user_version=2;",
        );
      });
    if (version < 3)
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE inbox ADD COLUMN media TEXT; ALTER TABLE inbox ADD COLUMN attachments TEXT; ALTER TABLE outbox ADD COLUMN media TEXT; ALTER TABLE outbox ADD COLUMN wire TEXT; PRAGMA user_version=3;",
        );
      });
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
          .prepare(
            "INSERT OR IGNORE INTO inbox(key,text,unsupported,received,media) VALUES(?,?,?,?,?)",
          )
          .run(
            key,
            msg.text,
            Number(msg.unsupported),
            Date.now(),
            msg.media?.length ? JSON.stringify(msg.media) : null,
          );
        if (Number(inserted.changes) > 0) {
          this.set("lastInboundAt", String(Date.now()));
          if (msg.contextToken) this.set("contextToken", msg.contextToken);
        }
      }
      if (messages.length)
        this.db
          .prepare("UPDATE outbox SET state='pending',attempts=0,due=0 WHERE state='blocked'")
          .run();
      this.set("syncCursor", cursor);
    });
  }
  lastInboundAt(): number | undefined {
    const stored = Number(this.get("lastInboundAt"));
    if (Number.isFinite(stored) && stored > 0) return stored;
    const row = z
      .object({ at: z.number().nullable() })
      .parse(this.db.prepare("SELECT MAX(received) AS at FROM inbox").get());
    return row.at && row.at > 0 ? row.at : undefined;
  }
  target(): Target | undefined {
    const raw = this.get("target");
    return raw ? TargetSchema.parse(JSON.parse(raw)) : undefined;
  }
  generation(): string {
    return this.get("routeGeneration") || "0";
  }
  reconcile(): void {
    this.transaction(() => this.#retireOthers(this.target()?.id));
  }
  #retireOthers(id?: number): void {
    this.db
      .prepare("UPDATE watches SET active=0,approval=0 WHERE id!=? OR ? IS NULL")
      .run(id ?? null, id ?? null);
    this.db
      .prepare(
        "UPDATE outbox SET state='cancelled',text='',media=NULL,wire=NULL WHERE conversation IS NOT NULL AND state!='sent' AND NOT EXISTS (SELECT 1 FROM watches WHERE watches.id=outbox.conversation AND active=1)",
      )
      .run();
  }
  select(target: Target, cursor: number): void {
    this.transaction(() => this.#select(target, cursor));
  }
  #select(target: Target, cursor: number): void {
    if (this.target()?.id !== target.id || !this.watches().some((w) => w.id === target.id))
      this.set("routeGeneration", String(Number(this.generation()) + 1));
    this.#retireOthers(target.id);
    this.watch(target, cursor);
    this.set("target", JSON.stringify(target));
  }
  job(): Job | undefined {
    const row = this.db.prepare("SELECT * FROM inbox WHERE done=0 ORDER BY seq LIMIT 1").get();
    return row ? JobSchema.parse(row) : undefined;
  }
  prepareJob(delay: number): Job | undefined {
    let row = this.db.prepare("SELECT * FROM inbox WHERE done=0 ORDER BY seq LIMIT 1").get();
    if (!row) return undefined;
    if (typeof row.text === "string" && !row.text.startsWith("/")) {
      const command = this.db
        .prepare(
          "SELECT * FROM inbox WHERE done=0 AND unsupported=0 AND text LIKE '/%' ORDER BY seq LIMIT 1",
        )
        .get();
      if (command?.text === "/stop") row = command;
    }
    const first = JobSchema.extend({ sealed: z.number(), received: z.number() }).parse(row);
    if (
      !delay ||
      !first.received ||
      first.sealed ||
      first.target ||
      first.unsupported ||
      first.media ||
      first.text.startsWith("/") ||
      first.creating
    )
      return first;
    const rows = z
      .array(JobSchema.extend({ sealed: z.number(), received: z.number() }))
      .parse(this.db.prepare("SELECT * FROM inbox WHERE done=0 ORDER BY seq LIMIT 101").all());
    const batch = [first];
    let text = first.text;
    let boundary = false;
    const quiet = (text: string) => Math.max(delay, Array.from(text).length >= 1800 ? 1000 : 0);
    for (const next of rows.slice(1)) {
      const previous = batch.at(-1)!;
      if (
        next.sealed ||
        next.target ||
        next.unsupported ||
        next.media ||
        next.creating ||
        next.text.startsWith("/") ||
        next.received - previous.received > quiet(previous.text) ||
        text.length + next.text.length + 1 > 32_000 ||
        batch.length >= 100
      ) {
        boundary = true;
        break;
      }
      batch.push(next);
      text += "\n" + next.text;
    }
    const last = batch.at(-1)!;
    if (!boundary && Date.now() < last.received + quiet(last.text)) return undefined;
    this.transaction(() => {
      this.db.prepare("UPDATE inbox SET text=?,sealed=1 WHERE key=?").run(text, first.key);
      for (const member of batch.slice(1))
        this.db.prepare("UPDATE inbox SET done=1,text='' WHERE key=?").run(member.key);
    });
    return { ...first, text };
  }
  pinJob(key: string, target: Target): void {
    this.db
      .prepare("UPDATE inbox SET target=? WHERE key=? AND target IS NULL")
      .run(JSON.stringify(target), key);
  }
  saveAttachments(key: string, attachments: Attachment[]): void {
    this.db
      .prepare("UPDATE inbox SET attachments=? WHERE key=? AND done=0")
      .run(JSON.stringify(attachments), key);
  }
  beginStop(key: string, target: Target): void {
    this.transaction(() => {
      this.pinJob(key, target);
      this.set("stopIntent", key);
      this.db
        .prepare(
          "UPDATE inbox SET done=1,text='',media=NULL,attachments=NULL WHERE done=0 AND seq<(SELECT seq FROM inbox WHERE key=?) AND text NOT LIKE '/%' AND (target IS NULL OR json_extract(target,'$.id')=?)",
        )
        .run(key, target.id);
    });
  }
  beginReset(key: string, target: Target): void {
    this.transaction(() => {
      this.pinJob(key, target);
      this.set("resetIntent", key);
    });
  }
  markCreating(key: string): void {
    this.db.prepare("UPDATE inbox SET creating=1 WHERE key=?").run(key);
  }
  finish(
    key: string,
    response?: string,
    created?: Target,
    media?: { blob: MediaBlob; conversation: number }[],
    diagnostic = false,
  ): void {
    this.transaction(() => {
      if (created) this.#select(created, 0);
      // A media row leads its own text: it can only be sent after a CDN upload (up to 120s), so
      // text enqueued first is delivered alone and the pair reads as a mismatch. Media first also
      // makes the text its immediate successor, which a queue bypass (/status) cannot separate.
      media?.forEach((item, index) =>
        this.enqueueMedia(`command:${key}:media:${index}`, item.blob, item.conversation),
      );
      if (response) this.enqueue(`command:${key}`, response);
      if (response && diagnostic) this.set("diagnosticReply", stableId(`command:${key}`, "0"));
      this.db
        .prepare("UPDATE inbox SET done=1,text='',media=NULL,attachments=NULL WHERE key=?")
        .run(key);
      for (const intent of [
        "resetIntent",
        "stopIntent",
        "interruptIntent",
        "interruptStopped",
        "modelIntent",
      ])
        if (this.get(intent) === key) this.set(intent, "");
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
          "UPDATE outbox SET state='cancelled',text='',media=NULL,wire=NULL WHERE conversation=? AND state!='sent'",
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
    const chunks = splitText(this.outboundText(text));
    chunks.forEach((chunk, index) => {
      this.db
        .prepare("INSERT OR IGNORE INTO outbox(key,text,conversation) VALUES(?,?,?)")
        .run(stableId(key, String(index)), chunk, conversation ?? null);
    });
  }
  enqueueMedia(key: string, blob: MediaBlob, conversation: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO outbox(key,text,conversation,media) VALUES(?,'',?,?)")
      .run(stableId(key, "0"), conversation, JSON.stringify(BlobSchema.parse(blob)));
  }
  saveWire(key: string, wire: string): void {
    this.db.prepare("UPDATE outbox SET wire=? WHERE key=? AND state='pending'").run(wire, key);
  }
  mediaInUse(): Set<string> {
    const rows = z
      .array(z.object({ media: z.string() }))
      .parse(
        this.db
          .prepare(
            "SELECT media FROM outbox WHERE media IS NOT NULL AND state IN ('pending','blocked','failed')",
          )
          .all(),
      );
    return new Set(rows.map((row) => BlobSchema.parse(JSON.parse(row.media)).id));
  }
  delivery(): Delivery | undefined {
    const diagnostic = this.get("diagnosticReply");
    if (diagnostic) {
      const row = this.db
        .prepare("SELECT * FROM outbox WHERE key=? AND state='pending' AND due<=?")
        .get(diagnostic, Date.now());
      if (row) return DeliverySchema.parse(row);
    }
    const row = this.db
      .prepare(
        "SELECT * FROM outbox WHERE state IN ('pending','blocked','failed') ORDER BY seq LIMIT 1",
      )
      .get();
    return row ? DeliverySchema.parse(row) : undefined;
  }
  isPending(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE key=? AND state='pending'").get(key);
  }
  sent(key: string): void {
    if (this.get("diagnosticReply") === key) this.set("diagnosticReply", "");
    this.db
      .prepare("UPDATE outbox SET state='sent',text='',media=NULL,wire=NULL WHERE key=?")
      .run(key);
  }
  deliveryFailed(row: Delivery, blocked: boolean, delay = 0): void {
    this.db
      .prepare(
        "UPDATE outbox SET state=?,attempts=attempts+1,due=? WHERE key=? AND state='pending'",
      )
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
