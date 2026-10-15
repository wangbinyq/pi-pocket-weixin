import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Account, Config } from "../src/config.ts";
import { Bridge } from "../src/bridge.ts";
import { HttpError } from "../src/http.ts";
import type { Updates, WeixinPort } from "../src/ilink.ts";
import type {
  Entry,
  PocketPort,
  PocketSession,
  Running,
  Target,
  PocketModel,
  Diagnostics,
} from "../src/pocket.ts";
import { Store } from "../src/store.ts";
import type { Attachment, MediaBlob, MediaRef } from "../src/media.ts";
import type { MediaItem } from "../src/weixin-media.ts";

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
  resets: { id: number; note?: string }[] = [];
  stops: number[] = [];
  modelChanges: { id: number; provider: string; modelId: string; thinkingLevel?: string }[] = [];
  availableModels: PocketModel[] = [
    { provider: "test", id: "model", name: "Test", levels: ["off", "high"], images: true },
  ];
  modes: string[] = [];
  uploads: { id: number; data: Buffer; attachment: Attachment }[] = [];
  submittedAttachments: Attachment[][] = [];
  directory = "/tmp";
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
  async submit(
    id: number,
    text: string,
    requestId: string,
    mode = "followUp",
    attachments: Attachment[] = [],
  ): Promise<void> {
    this.submittedAttachments.push(attachments);
    this.modes.push(mode);
    this.calls.push(requestId);
    this.requests.set(requestId, { id, text });
    if (this.failSubmit) throw new Error("Response lost after server commit");
  }
  async cwd(): Promise<string> {
    return this.directory;
  }
  async upload(id: number, data: Buffer, name: string, mime: string): Promise<Attachment> {
    const attachment = {
      path: `/uploads/${id}/${this.uploads.length}-${name}`,
      name,
      mime,
      size: data.length,
    };
    this.uploads.push({ id, data, attachment });
    return attachment;
  }
  async stop(id: number): Promise<void> {
    this.stops.push(id);
    this.active = this.active.filter((entry) => entry.id !== id);
  }
  async models(): Promise<PocketModel[]> {
    return this.availableModels;
  }
  async model(
    id: number,
    provider: string,
    modelId: string,
    thinkingLevel?: string,
  ): Promise<void> {
    this.modelChanges.push({ id, provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) });
  }
  async reset(id: number, note?: string): Promise<void> {
    this.resets.push({ id, ...(note === undefined ? {} : { note }) });
  }
  diagnosticData: Diagnostics = {};
  diagnosticIds: number[] = [];
  async diagnostics(id: number): Promise<Diagnostics> {
    await this.head(id);
    this.diagnosticIds.push(id);
    return this.diagnosticData;
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
  typingStates: boolean[] = [];
  downloads: MediaRef[] = [];
  downloadData = Buffer.from("file contents");
  uploaded: MediaBlob[] = [];
  mediaSent: { item: MediaItem; clientId: string; token?: string }[] = [];
  async download(ref: MediaRef): Promise<Buffer> {
    this.downloads.push(ref);
    return this.downloadData;
  }
  async upload(_peer: string, blob: MediaBlob): Promise<MediaItem> {
    this.uploaded.push(blob);
    const media = {
      encrypt_query_param: "upload-param",
      aes_key: Buffer.alloc(16).toString("base64"),
      encrypt_type: 1 as const,
    };
    return blob.kind === "image"
      ? { type: 2, image_item: { media, mid_size: 16 } }
      : { type: 4, file_item: { media, file_name: blob.name, len: String(blob.size) } };
  }
  async sendMedia(_peer: string, item: MediaItem, clientId: string, token?: string): Promise<void> {
    if (this.fail) throw this.fail;
    this.mediaSent.push({ item, clientId, token });
  }
  async typing(_peer: string, active: boolean): Promise<void> {
    this.typingStates.push(active);
  }
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
