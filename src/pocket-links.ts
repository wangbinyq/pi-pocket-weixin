import { pocketBase } from "./http.ts";

export const NO_PUBLIC_LINK = "Pocket 公网链接未配置（请设置 POCKET_PUBLIC_URL 后在网页查看）。";
const loopbacks = new Set(["localhost", "127.0.0.1", "127.0.0.2", "[::1]"]);

export class PocketLinks {
  readonly api: URL;
  readonly publicOrigin?: string;
  constructor(api: string, publicUrl?: string) {
    this.api = new URL(pocketBase(api));
    this.publicOrigin = publicUrl ? pocketBase(publicUrl) : undefined;
  }
  session(id: number): string {
    return this.publicOrigin ? `${this.publicOrigin}/s/${id}` : NO_PUBLIC_LINK;
  }
  rewrite(text: string): string {
    return text.replace(
      /https?:\/\/[^\s<>"'`，。！？；、）】]+|(?<![:\w/])\/\/[^\s<>"'`，。！？；、）】]+|(?<![\w/:?=&#])\/s\/\d+(?:\?[^\s<>"'`，。！？；、）】)\]]*)?(?:#[^\s<>"'`，。！？；、）】)\]]*)?/giu,
      (raw) => {
        // A URL never carries non-ASCII text, so prose glued to its right is cut off
        // first: new URL() would otherwise percent-encode it.
        let candidate = /^[ -~]*/.exec(raw)![0];
        if (!candidate) return raw;
        let suffix = raw.slice(candidate.length);
        const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
        while (candidate) {
          const last = candidate.at(-1)!;
          if (
            !/[.,;!?。，；！？、）】]/u.test(last) &&
            !(
              opening[last] && candidate.split(last).length > candidate.split(opening[last]!).length
            )
          )
            break;
          suffix = last + suffix;
          candidate = candidate.slice(0, -1);
        }
        let url: URL;
        try {
          url = new URL(
            candidate.startsWith("//") ? this.api.protocol + candidate : candidate,
            this.api,
          );
        } catch {
          return raw;
        }
        const known =
          url.origin === this.api.origin ||
          url.origin === this.publicOrigin ||
          (loopbacks.has(this.api.hostname) &&
            loopbacks.has(url.hostname) &&
            url.port === this.api.port);
        if (!known) return raw;
        if (!this.publicOrigin) return NO_PUBLIC_LINK + suffix;
        if (/^\/(?:login|join)(?:\/|$)/i.test(url.pathname))
          return "（Pocket 登录链接已隐藏，请在网页登录）" + suffix;
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()]) {
          if (!/^(?:entry|entryId|from|before|path|line|tab|sheet|download)$/i.test(key))
            url.searchParams.delete(key);
        }
        if (url.hash && !/^#(?:entry[-=]?)?\d+$/.test(url.hash)) url.hash = "";
        return this.publicOrigin + url.pathname + url.search + url.hash + suffix;
      },
    );
  }
}
