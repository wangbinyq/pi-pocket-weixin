import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Account } from "./config.ts";
import { type Fetcher, ilinkBase, requestJson } from "./http.ts";

const BASE = "https://ilinkai.weixin.qq.com";
const APP_HEADERS = {
  "iLink-App-Id": "bot",
  "iLink-App-ClientVersion": String((2 << 16) | (2 << 8)),
};
const Envelope = z.object({
  ret: z.number().optional(),
  errcode: z.number().optional(),
  errmsg: z.string().optional(),
  msg: z.string().optional(),
});
const Message = z.object({
  message_id: z.union([z.string().min(1), z.number().int().safe()]).transform(String),
  from_user_id: z.string().min(1),
  to_user_id: z.string().optional(),
  message_type: z.number().optional(),
  room_id: z.string().optional(),
  chat_room_id: z.string().optional(),
  context_token: z.string().optional(),
  item_list: z.array(
    z.object({ type: z.number(), text_item: z.object({ text: z.string() }).optional() }),
  ),
});
export interface Incoming {
  messageId: string;
  peer: string;
  text: string;
  contextToken?: string;
  unsupported: boolean;
}
export interface Updates {
  cursor: string;
  messages: unknown[];
}
export class ILinkError extends Error {
  readonly kind: "auth" | "session" | "rate" | "other";
  constructor(ret: number | undefined, code: number | undefined, description: string) {
    const stale =
      [ret, code].includes(-2) &&
      ["prepare failed", "unknown error"].includes(description.toLowerCase());
    const kind = [ret, code].includes(-14)
      ? "auth"
      : stale
        ? "session"
        : [ret, code].includes(-2)
          ? "rate"
          : "other";
    super(`iLink ${kind} error (ret=${ret ?? "?"}, errcode=${code ?? "?"})`);
    this.kind = kind;
  }
}
function checkEnvelope(value: unknown): void {
  const result = Envelope.parse(value);
  if (
    (result.ret !== undefined && result.ret !== 0) ||
    (result.errcode !== undefined && result.errcode !== 0)
  ) {
    throw new ILinkError(result.ret, result.errcode, result.errmsg || result.msg || "");
  }
}
export function incomingFor(value: unknown, account: Account): Incoming | undefined {
  const result = Message.safeParse(value);
  if (!result.success) return undefined;
  const msg = result.data;
  if (
    msg.from_user_id !== account.peer ||
    msg.from_user_id === account.accountId ||
    msg.room_id ||
    msg.chat_room_id ||
    (msg.to_user_id && msg.to_user_id !== account.accountId) ||
    (msg.message_type !== undefined && msg.message_type !== 1)
  )
    return undefined;
  const text = msg.item_list
    .flatMap((item) => (item.type === 1 && item.text_item ? [item.text_item.text] : []))
    .join("\n")
    .trim();
  return {
    messageId: msg.message_id,
    peer: msg.from_user_id,
    text: text.slice(0, 32_000),
    contextToken: msg.context_token,
    unsupported: !text || text.length > 32_000 || msg.item_list.some((item) => item.type !== 1),
  };
}

export interface WeixinPort {
  updates(cursor: string, signal?: AbortSignal): Promise<Updates>;
  send(
    peer: string,
    text: string,
    clientId: string,
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}
export class ILink implements WeixinPort {
  readonly account: Account;
  readonly fetcher: Fetcher;
  #pollTimeout = 35_000;
  constructor(account: Account, fetcher: Fetcher = fetch) {
    this.account = { ...account, baseUrl: ilinkBase(account.baseUrl) };
    this.fetcher = fetcher;
  }
  async #post(
    endpoint: string,
    payload: object,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const value = await requestJson(
      this.fetcher,
      `${this.account.baseUrl}/ilink/bot/${endpoint}`,
      {
        method: "POST",
        headers: {
          ...APP_HEADERS,
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${this.account.token}`,
          "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
        },
        body: JSON.stringify({ ...payload, base_info: { channel_version: "2.2.0" } }),
      },
      timeout,
      signal,
    );
    checkEnvelope(value);
    return value;
  }
  async updates(cursor: string, signal?: AbortSignal): Promise<Updates> {
    try {
      const value = await this.#post(
        "getupdates",
        { get_updates_buf: cursor },
        this.#pollTimeout,
        signal,
      );
      const parsed = z
        .object({
          msgs: z.array(z.unknown()).optional(),
          get_updates_buf: z.string().optional(),
          longpolling_timeout_ms: z.number().optional(),
        })
        .parse(value);
      if (parsed.longpolling_timeout_ms)
        this.#pollTimeout = Math.max(1000, Math.min(parsed.longpolling_timeout_ms, 60_000));
      return { cursor: parsed.get_updates_buf ?? cursor, messages: parsed.msgs ?? [] };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError" && !signal?.aborted)
        return { cursor, messages: [] };
      throw error;
    }
  }
  async send(
    peer: string,
    text: string,
    clientId: string,
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!text.trim()) throw new Error("Cannot send an empty message");
    await this.#post(
      "sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: peer,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      },
      15_000,
      signal,
    );
  }
}

export async function qrLogin(
  show: (url: string) => Promise<void>,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<Account> {
  const get = async (base: string, path: string) => {
    const value = await requestJson(
      fetcher,
      `${ilinkBase(base)}/ilink/bot/${path}`,
      { headers: APP_HEADERS },
      35_000,
      signal,
    );
    checkEnvelope(value);
    return value;
  };
  let base = BASE;
  let qr = "";
  let refreshes = 0;
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!qr) {
      const response = z
        .object({ qrcode: z.string().min(1), qrcode_img_content: z.string().url() })
        .parse(await get(BASE, "get_bot_qrcode?bot_type=3"));
      qr = response.qrcode;
      base = BASE;
      await show(response.qrcode_img_content);
    }
    let raw: unknown;
    try {
      raw = await get(base, `get_qrcode_status?qrcode=${encodeURIComponent(qr)}`);
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError") || signal?.aborted)
        throw error;
      continue;
    }
    const response = z
      .object({
        status: z.string(),
        redirect_host: z.string().optional(),
        ilink_bot_id: z.string().optional(),
        bot_token: z.string().optional(),
        baseurl: z.string().optional(),
        ilink_user_id: z.string().optional(),
      })
      .parse(raw);
    if (response.status === "confirmed") {
      if (!response.ilink_bot_id || !response.bot_token || !response.ilink_user_id) {
        throw new Error(
          "QR login did not return a bot, credential, and user identity; refusing an unbound bot",
        );
      }
      return {
        accountId: response.ilink_bot_id,
        token: response.bot_token,
        peer: response.ilink_user_id,
        baseUrl: ilinkBase(response.baseurl || BASE),
      };
    }
    if (response.status === "scaned_but_redirect" && response.redirect_host)
      base = ilinkBase(`https://${response.redirect_host}`);
    if (response.status === "expired") {
      if (++refreshes > 3) throw new Error("QR code expired repeatedly; run login again");
      qr = "";
    }
    await sleep(1000, undefined, { signal });
  }
  throw new Error("QR login timed out; run login again");
}
