import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Account, Config } from "../src/config.ts";
import { Bridge } from "../src/bridge.ts";
import { HttpError } from "../src/http.ts";
import type { Updates, WeixinPort } from "../src/ilink.ts";
import type { Entry, PocketPort, PocketSession, Running, Target } from "../src/pocket.ts";
import { Store } from "../src/store.ts";

export const account: Account = {
  accountId: "test-bot",
  token: "test-token",
  baseUrl: "https://ilinkai.weixin.qq.com",
  peer: "test-owner",
};
export class FakePocket implements PocketPort {
  user = "owner";
  rows = new Map<number, Entry[]>([
    [1, []],
    [2, []],
  ]);
  requests = new Map<string, { id: number; text: string }>();
  calls: string[] = [];
  active: Running[] = [];
  failSubmit = false;
  failCreate = false;
  created = 0;
  denied = new Set<number>();
  async principal(): Promise<string> {
    return this.user;
  }
  async sessions(): Promise<PocketSession[]> {
    return [...this.rows.keys()]
      .filter((id) => id !== 1 && !this.denied.has(id))
      .map((id) => ({ id, title: "Session " + id, cwd: "/tmp", busy: false, waiting: false }));
  }
  async pip(): Promise<Target> {
    return { id: 1, title: "Pi in Pocket", pip: true };
  }
  async head(id: number): Promise<number> {
    if (this.denied.has(id)) throw new HttpError("Pocket", 403);
    return Math.max(0, ...(this.rows.get(id) || []).map((entry) => entry.id));
  }
  async after(id: number, cursor: number): Promise<Entry[]> {
    await this.head(id);
    return (this.rows.get(id) || []).filter((entry) => entry.id > cursor);
  }
  async create(title: string): Promise<Target> {
    this.created++;
    const id = 100 + this.created;
    this.rows.set(id, []);
    if (this.failCreate) throw new Error("Response lost after server commit");
    return { id, title, pip: false };
  }
  async submit(id: number, text: string, requestId: string): Promise<void> {
    this.calls.push(requestId);
    this.requests.set(requestId, { id, text });
    if (this.failSubmit) throw new Error("Response lost after server commit");
  }
  async running(): Promise<Running[]> {
    return this.active;
  }
  link(id: number): string {
    return "https://pocket.example.com/s/" + id;
  }
}
export class FakeWeixin implements WeixinPort {
  batch: Updates = { cursor: "next", messages: [] };
  sent: { peer: string; text: string; clientId: string; token?: string }[] = [];
  fail?: Error;
  async updates(): Promise<Updates> {
    return this.batch;
  }
  async send(peer: string, text: string, clientId: string, token?: string): Promise<void> {
    if (this.fail) throw this.fail;
    this.sent.push({ peer, text, clientId, token });
  }
}
export function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-weixin-test-"));
  const store = new Store(dir);
  const pocket = new FakePocket();
  const weixin = new FakeWeixin();
  const config: Config = {
    dataDir: dir,
    pocketUrl: "https://pocket.example.com",
    pocketToken: "test-pocket-token",
    publicUrl: "https://pocket.example.com",
    textBatchDelayMs: 0,
  };
  const bridge = new Bridge(store, pocket, weixin, account, config, () => {});
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let seq = 0;
  const input = (text: string, messageId = String(++seq)) => {
    store.ingest(account, "cursor-" + messageId, [
      { messageId, peer: account.peer, text, unsupported: false, contextToken: "test-context" },
    ]);
  };
  const reply = (id: number, entry: number, text: string) =>
    pocket.rows.get(id)?.push({
      id: entry,
      kind: "assistant",
      blocks: [{ type: "text", text }],
      stopReason: "stop",
    });
  return { dir, store, pocket, weixin, config, bridge, input, reply };
}
