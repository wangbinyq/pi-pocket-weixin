import { createCipheriv, createDecipheriv } from "node:crypto";
import { z } from "zod";
import { MediaError } from "./media.ts";

export const CDN = "https://novac2c.cdn.weixin.qq.com/c2c";
const hosts = new Set([
  "novac2c.cdn.weixin.qq.com",
  "ilinkai.weixin.qq.com",
  "wx.qlogo.cn",
  "thirdwx.qlogo.cn",
  "res.wx.qq.com",
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
]);
export function cdnUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaError("媒体地址格式不正确。");
  }
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new MediaError("媒体地址不在受信任的微信 HTTPS CDN 范围内。");
  return url.href;
}
export function aesKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new MediaError("媒体密钥格式不正确。");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii")))
    return Buffer.from(decoded.toString("ascii"), "hex");
  throw new MediaError("媒体密钥长度不正确。");
}
export function encrypt(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
export function decrypt(data: Buffer, key: Buffer): Buffer {
  try {
    const cipher = createDecipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  } catch {
    throw new MediaError("附件解密失败，本条消息未提交。");
  }
}
const Media = z.object({
  encrypt_query_param: z.string().min(1),
  aes_key: z.string().min(1),
  encrypt_type: z.literal(1),
});
export const MediaItemSchema = z.union([
  z.object({
    type: z.literal(2),
    image_item: z.object({ media: Media, mid_size: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal(4),
    file_item: z.object({ media: Media, file_name: z.string(), len: z.string() }),
  }),
]);
export type MediaItem = z.infer<typeof MediaItemSchema>;
