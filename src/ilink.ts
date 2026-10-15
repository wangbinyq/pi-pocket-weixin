import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Account } from "./config.ts";
import {
  type Fetcher,
  HttpError,
  ResponseSizeError,
  ilinkBase,
  requestJson,
  requestBytes,
} from "./http.ts";

import { MAX_MEDIA, MediaError, type MediaRef, type MediaBlob } from "./media.ts";
import {
  aesKey,
  CDN,
  cdnUrl,
  decrypt,
  encrypt,
  type MediaItem,
  MediaItemSchema,
} from "./weixin-media.ts";

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
const Item = z.object({
  type: z.number(),
  text_item: z.object({ text: z.string() }).optional(),
  image_item: z.unknown().optional(),
  file_item: z.unknown().optional(),
  ref_msg: z
    .object({ title: z.string().optional(), message_item: z.unknown().optional() })
    .optional(),
});
function quotedText(
  value: unknown,
  depth = 0,
): { text: string; unsupported: boolean; media?: MediaRef[] } {
  const parsed = Item.safeParse(value);
  if (!parsed.success || depth >= 8) return { text: "", unsupported: true };
  if ([2, 4].includes(parsed.data.type)) {
    const image = parsed.data.type === 2;
    const payload = z
      .object({
        media: z.object({
          encrypt_query_param: z.string().optional(),
          aes_key: z.string().optional(),
          full_url: z.string().optional(),
        }),
        aeskey: z.string().optional(),
        file_name: z.string().optional(),
      })
      .safeParse(image ? parsed.data.image_item : parsed.data.file_item);
    if (
      !payload.success ||
      (!payload.data.media.encrypt_query_param && !payload.data.media.full_url)
    )
      return { text: "", unsupported: true };
    const source = payload.data;
    if (image && source.aeskey && !/^[a-f0-9]{32}$/i.test(source.aeskey))
      return { text: "", unsupported: true };
    return {
      text: "",
      unsupported: false,
      media: [
        {
          kind: image ? "image" : "file",
          name: image ? "image.jpg" : source.file_name || "document.bin",
          query: source.media.encrypt_query_param,
          url: source.media.full_url,
          key:
            image && source.aeskey
              ? Buffer.from(source.aeskey, "hex").toString("base64")
              : source.media.aes_key,
        },
      ],
    };
  }
  if (parsed.data.type !== 1 || !parsed.data.text_item) return { text: "", unsupported: true };
  const item = parsed.data;
  const text = item.text_item!.text;
  if (!item.ref_msg?.message_item) return { text, unsupported: false };
  const quote = quotedText(item.ref_msg.message_item, depth + 1);
  const context = [item.ref_msg.title, quote.text].filter(Boolean).join(" | ");
  return {
    text: context || quote.media?.length ? `[引用: ${context || "附件"}]\n${text}` : text,
    unsupported: quote.unsupported,
    media: quote.media,
  };
}
const Message = z.object({
  message_id: z.union([z.string().min(1), z.number().int().safe()]).transform(String),
  from_user_id: z.string().min(1),
  to_user_id: z.string().optional(),
  message_type: z.number().optional(),
  room_id: z.string().optional(),
  chat_room_id: z.string().optional(),
  context_token: z.string().optional(),
  item_list: z.array(Item),
});
export interface Incoming {
  messageId: string;
  peer: string;
  text: string;
  contextToken?: string;
  unsupported: boolean;
  media?: MediaRef[];
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
function parseILinkJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (
      key === "message_id" &&
      typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      context?.source &&
      /^\d+$/.test(context.source)
    )
      return context.source;
    return value;
  }) as unknown;
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
  const items = msg.item_list.map((item) => quotedText(item));
  const text = items
    .map((item) => item.text)
    .join("\n")
    .trim();
  const media = items.flatMap((item) => item.media || []);
  return {
    ...(media.length ? { media } : {}),
    messageId: msg.message_id,
    peer: msg.from_user_id,
    text: text.slice(0, 32_000),
    contextToken: msg.context_token,
    unsupported:
      (!text && !media.length) ||
      text.length > 32_000 ||
      media.length > 8 ||
      items.some((item) => item.unsupported),
  };
}

export interface WeixinPort {
  typing(peer: string, active: boolean, contextToken?: string): Promise<void>;
  download(ref: MediaRef, signal?: AbortSignal): Promise<Buffer>;
  upload(peer: string, blob: MediaBlob, data: Buffer, signal?: AbortSignal): Promise<MediaItem>;
  sendMedia(
    peer: string,
    item: MediaItem,
    clientId: string,
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<void>;
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
  #typingTicket?: { value: string; expires: number };
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
      parseILinkJson,
    );
    checkEnvelope(value);
    return value;
  }
  async typing(peer: string, active: boolean, contextToken?: string): Promise<void> {
    if (!this.#typingTicket || this.#typingTicket.expires <= Date.now()) {
      const config = z.object({ typing_ticket: z.string().optional() }).parse(
        await this.#post(
          "getconfig",
          {
            ilink_user_id: peer,
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          10_000,
        ),
      );
      if (!config.typing_ticket) return;
      this.#typingTicket = { value: config.typing_ticket, expires: Date.now() + 600_000 };
    }
    await this.#post(
      "sendtyping",
      { ilink_user_id: peer, typing_ticket: this.#typingTicket.value, status: active ? 1 : 2 },
      10_000,
    );
  }
  async download(ref: MediaRef, signal?: AbortSignal): Promise<Buffer> {
    const url = cdnUrl(
      ref.query
        ? `${CDN}/download?encrypted_query_param=${encodeURIComponent(ref.query)}`
        : ref.url || "",
    );
    let bytes: Buffer;
    try {
      ({ bytes } = await requestBytes(this.fetcher, url, {}, 60_000, MAX_MEDIA + 16, signal));
    } catch (error) {
      if (error instanceof ResponseSizeError)
        throw new MediaError("附件超过 20 MiB，本条消息未提交。");
      if (error instanceof HttpError && [400, 403, 404, 410, 413].includes(error.status))
        throw new MediaError("微信附件不可下载或已过期，本条消息未提交，请重新发送。");
      throw error;
    }
    const plain = ref.key ? decrypt(bytes, aesKey(ref.key)) : bytes;
    if (!plain.length || plain.length > MAX_MEDIA) throw new MediaError("附件为空或超过 20 MiB。");
    return plain;
  }
  async upload(
    peer: string,
    blob: MediaBlob,
    data: Buffer,
    signal?: AbortSignal,
  ): Promise<MediaItem> {
    if (!data.length || data.length > MAX_MEDIA) throw new MediaError("附件为空或超过 20 MiB。");
    const key = randomBytes(16),
      filekey = randomBytes(16).toString("hex");
    const encrypted = encrypt(data, key);
    const response = z
      .object({ upload_param: z.string().optional(), upload_full_url: z.string().optional() })
      .parse(
        await this.#post(
          "getuploadurl",
          {
            filekey,
            media_type: blob.kind === "image" ? 1 : 3,
            to_user_id: peer,
            rawsize: data.length,
            rawfilemd5: createHash("md5").update(data).digest("hex"),
            filesize: encrypted.length,
            no_need_thumb: true,
            aeskey: key.toString("hex"),
          },
          15_000,
          signal,
        ),
      );
    if (!response.upload_full_url && !response.upload_param)
      throw new Error("Missing CDN upload URL");
    const url = cdnUrl(
      response.upload_full_url ||
        `${CDN}/upload?encrypted_query_param=${encodeURIComponent(response.upload_param!)}&filekey=${filekey}`,
    );
    const result = await requestBytes(
      this.fetcher,
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(encrypted),
      },
      120_000,
      64 * 1024,
      signal,
    );
    const param = result.headers.get("x-encrypted-param");
    if (!param) throw new Error("Missing encrypted CDN parameter");
    const media = {
      encrypt_query_param: param,
      aes_key: Buffer.from(key.toString("hex")).toString("base64"),
      encrypt_type: 1 as const,
    };
    return MediaItemSchema.parse(
      blob.kind === "image"
        ? { type: 2, image_item: { media, mid_size: encrypted.length } }
        : { type: 4, file_item: { media, file_name: blob.name, len: String(data.length) } },
    );
  }
  async sendMedia(
    peer: string,
    item: MediaItem,
    clientId: string,
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#post(
      "sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: peer,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [MediaItemSchema.parse(item)],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      },
      15_000,
      signal,
    );
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
