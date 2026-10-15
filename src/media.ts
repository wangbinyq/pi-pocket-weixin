import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { oneLine } from "./format.ts";

export const MAX_MEDIA = 20 * 1024 * 1024;
export const MediaRefSchema = z.object({
  kind: z.enum(["image", "file"]),
  name: z.string(),
  query: z.string().optional(),
  key: z.string().optional(),
  url: z.string().optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;
export const AttachmentSchema = z.object({
  path: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
export const BlobSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["image", "file"]),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative().max(MAX_MEDIA),
});
export type MediaBlob = z.infer<typeof BlobSchema>;
export class MediaError extends Error {}
export function safeName(name: string): string {
  return (
    oneLine(basename(name.replaceAll("\\", "/"))).replace(/[<>:"/\\|?*]/g, "_") || "document.bin"
  );
}
export function imageMime(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data);
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}
export function fileMime(name: string): string {
  const types: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
  };
  return types[extname(name).toLowerCase()] || "application/octet-stream";
}
export class MediaCache {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "media");
  }
  async put(data: Uint8Array, name: string, kind: "image" | "file"): Promise<MediaBlob> {
    if (!data.length || data.length > MAX_MEDIA)
      throw new MediaError("附件为空或超过 20 MiB，本条消息未提交。");
    const mime = kind === "image" ? imageMime(data) : fileMime(name);
    if (!mime) throw new MediaError("图片格式不可识别，仅支持 PNG、JPEG、GIF、WebP、BMP。");
    const id = createHash("sha256").update(data).digest("hex");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, id);
    const temp = join(this.dir, ".pending-" + randomUUID());
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    const directory = await open(this.dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { id, kind, name: safeName(name), mime, size: data.length };
  }
  async read(blob: MediaBlob): Promise<Buffer> {
    BlobSchema.parse(blob);
    const handle = await open(
      join(this.dir, blob.id),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const bytes = await readLimited(handle);
      if (
        bytes.length !== blob.size ||
        createHash("sha256").update(bytes).digest("hex") !== blob.id
      )
        throw new MediaError("附件缓存校验失败。");
      return bytes;
    } finally {
      await handle.close();
    }
  }
  async prune(keep: Set<string>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.dir)) {
      if (!/^(?:[a-f0-9]{64}|\.pending-[a-f0-9-]+)$/.test(id) || keep.has(id)) continue;
      const path = join(this.dir, id);
      if ((await stat(path)).mtimeMs < Date.now() - 7 * 86_400_000) await unlink(path);
    }
  }
}
async function readLimited(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const info = await handle.stat();
  if (!info.isFile() || info.size > MAX_MEDIA)
    throw new MediaError("只能发送不超过 20 MiB 的普通文件。");
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const part = Buffer.alloc(Math.min(64 * 1024, MAX_MEDIA + 1 - size));
    const { bytesRead } = await handle.read(part);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > MAX_MEDIA) throw new MediaError("文件超过 20 MiB。");
    chunks.push(part.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks);
}
export async function readExport(
  cwd: string,
  requested: string,
  dataDir: string,
): Promise<{ data: Buffer; name: string }> {
  const root = await realpath(cwd);
  const privateRoot = await realpath(dataDir);
  const file = await realpath(resolve(root, requested));
  const protect = (path: string) => {
    const rel = relative(root, path);
    const segments = path.split(sep);
    if (
      !rel ||
      rel === ".." ||
      rel.startsWith(".." + sep) ||
      isAbsolute(rel) ||
      root === sep ||
      path === privateRoot ||
      path.startsWith(privateRoot + sep) ||
      path === resolve(dataDir) ||
      path.startsWith(resolve(dataDir) + sep) ||
      segments.some((segment) =>
        [
          ".git",
          ".ssh",
          ".config",
          ".local",
          ".pi",
          ".pi-pocket",
          ".aws",
          ".kube",
          ".gnupg",
        ].includes(segment),
      ) ||
      segments.some((segment) =>
        /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|auth\.json|id_(?:rsa|ed25519).*|.*\.(?:sqlite(?:-wal|-shm)?|db|pem|key|p12|pfx))$/i.test(
          segment,
        ),
      )
    )
      throw new MediaError(
        "拒绝读取会话目录外、桥接状态目录或敏感配置文件。请将要发送的非敏感文件放在会话项目目录中。",
      );
  };
  protect(resolve(root, requested));
  protect(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (process.platform === "linux") protect(await realpath(`/proc/self/fd/${handle.fd}`));
    return { data: await readLimited(handle), name: safeName(requested) };
  } finally {
    await handle.close();
  }
}
