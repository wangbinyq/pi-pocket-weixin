import { z } from "zod";
import { type Fetcher, pocketBase, requestJson } from "./http.ts";
import { oneLine } from "./format.ts";

export const TargetSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  pip: z.boolean(),
});
export type Target = z.infer<typeof TargetSchema>;
const SessionSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().optional(),
  cwd: z.string(),
  busy: z.boolean(),
  waiting: z.boolean(),
  archived: z.boolean().optional(),
});
export type PocketSession = z.infer<typeof SessionSchema>;
const EntrySchema = z.object({
  id: z.number().int().positive(),
  kind: z.string(),
  blocks: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  stopReason: z.string().optional(),
  error: z.string().optional(),
});
export type Entry = z.infer<typeof EntrySchema>;
const RunningSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  busy: z.boolean(),
  approvals: z.number().int().nonnegative(),
});
export type Running = z.infer<typeof RunningSchema>;
export interface PocketPort {
  principal(): Promise<string>;
  sessions(): Promise<PocketSession[]>;
  pip(): Promise<Target>;
  head(id: number): Promise<number>;
  after(id: number, cursor: number): Promise<Entry[]>;
  create(title: string, cwd?: string): Promise<Target>;
  submit(id: number, text: string, requestId: string): Promise<void>;
  running(): Promise<Running[]>;
  link(id: number): string;
}
export class Pocket implements PocketPort {
  readonly base: string;
  readonly publicBase: string;
  readonly token: string;
  readonly fetcher: Fetcher;
  readonly signal?: AbortSignal;
  constructor(
    base: string,
    token: string,
    options: { publicUrl?: string; fetcher?: Fetcher; signal?: AbortSignal } = {},
  ) {
    this.base = pocketBase(base);
    this.publicBase = pocketBase(options.publicUrl || base);
    this.token = token;
    this.fetcher = options.fetcher || fetch;
    this.signal = options.signal;
  }
  async #request(path: string, body?: object): Promise<unknown> {
    return requestJson(
      this.fetcher,
      `${this.base}/api/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Pocket": "1",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      30_000,
      this.signal,
    );
  }
  async principal(): Promise<string> {
    const me = z
      .object({ user: z.object({ id: z.string().min(1), role: z.string() }) })
      .parse(await this.#request("me"));
    if (me.user.role !== "owner")
      throw new Error("This release only supports a Pocket owner paired to their own Weixin DM");
    return me.user.id;
  }
  async sessions(): Promise<PocketSession[]> {
    return z.array(SessionSchema).parse(await this.#request("sessions"));
  }
  async pip(): Promise<Target> {
    const result = z
      .object({ pip: z.object({ id: z.number().int().positive() }).nullable() })
      .parse(await this.#request("pip", { on: true }));
    if (!result.pip) throw new Error("Enable PiP in Pocket's Extensions first");
    return { id: result.pip.id, title: "Pi in Pocket", pip: true };
  }
  async #page(id: number, before?: number): Promise<Entry[]> {
    return z
      .array(EntrySchema)
      .parse(await this.#request(`c/${id}/history${before ? `?before=${before}` : ""}`));
  }
  async head(id: number): Promise<number> {
    return Math.max(0, ...(await this.#page(id)).map((entry) => entry.id));
  }
  async after(id: number, cursor: number): Promise<Entry[]> {
    const found = new Map<number, Entry>();
    let before: number | undefined;
    for (let page = 0; page < 1000; page++) {
      const entries = await this.#page(id, before);
      for (const entry of entries) if (entry.id > cursor) found.set(entry.id, entry);
      const first = Math.min(...entries.map((entry) => entry.id));
      if (entries.length === 0 || first <= cursor)
        return [...found.values()].sort((a, b) => a.id - b.id);
      if (before !== undefined && first >= before)
        throw new Error("Pocket history pagination did not advance");
      before = first;
    }
    throw new Error("History catch-up exceeds 1000 pages; cursor was not advanced");
  }
  async create(title: string, cwd?: string): Promise<Target> {
    const result = z.object({ id: z.number().int().positive() }).parse(
      await this.#request("sessions", {
        title: oneLine(title) || "Weixin",
        ...(cwd ? { cwd } : {}),
      }),
    );
    return { id: result.id, title: oneLine(title) || "Weixin", pip: false };
  }
  async submit(id: number, text: string, requestId: string): Promise<void> {
    z.object({ submissionId: z.number(), requestId: z.string() }).parse(
      await this.#request(`c/${id}/submit`, { text, requestId, mode: "followUp" }),
    );
  }
  async running(): Promise<Running[]> {
    return z.array(RunningSchema).parse(await this.#request("running"));
  }
  link(id: number): string {
    return `${this.publicBase}/s/${id}`;
  }
}

export function finalText(entry: Entry): string | undefined {
  if (
    entry.kind !== "assistant" ||
    entry.stopReason === "toolUse" ||
    entry.blocks?.some((block) => block.type === "toolCall")
  )
    return undefined;
  const text = (entry.blocks || [])
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n")
    .trim();
  if (entry.error || entry.stopReason === "error") return "任务失败，请在 Pocket 查看详情。";
  if (entry.stopReason === "aborted") return "任务已停止。";
  if (entry.stopReason === "length")
    return (text ? text + "\n\n" : "") + "回复达到长度限制，请在 Pocket 查看。";
  return text || undefined;
}
