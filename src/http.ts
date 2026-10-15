export type Fetcher = typeof fetch;

export class ResponseSizeError extends Error {}

export class HttpError extends Error {
  readonly status: number;
  constructor(service: string, status: number) {
    super(`${service}: HTTP ${status}`);
    this.status = status;
  }
}

export async function requestJson(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeout: number,
  signal?: AbortSignal,
  parse: (text: string) => unknown = JSON.parse,
): Promise<unknown> {
  const response = await requestBytes(fetcher, url, init, timeout, 8 * 1024 * 1024, signal);
  try {
    return parse(response.bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).hostname}`);
  }
}
export async function requestBytes(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  timeout: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; headers: Headers }> {
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(new URL(url).hostname, response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty HTTP response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new ResponseSizeError("HTTP response exceeds size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return { bytes: Buffer.concat(chunks), headers: response.headers };
}

export function pocketBase(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "127.0.0.2", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Pocket requires HTTPS (HTTP is allowed only on loopback)");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(
      "Pocket URL must be an origin, without credentials, paths, or query parameters",
    );
  }
  return url.origin;
}

export function ilinkBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "ilinkai.weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com")) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Untrusted iLink service URL");
  return url.origin;
}
