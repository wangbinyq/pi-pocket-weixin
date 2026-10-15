import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import QRCode from "qrcode";
import { Bridge } from "./bridge.ts";
import { dataDirectory, loadAccount, loadConfig, privateDirectory, saveAccount } from "./config.ts";
import { stableId } from "./format.ts";
import { ILink, qrLogin } from "./ilink.ts";
import { Pocket } from "./pocket.ts";
import { Store } from "./store.ts";

process.umask(0o077);
if (existsSync(".env")) process.loadEnvFile(".env");
const command = process.argv[2] || "help";
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function main(): Promise<void> {
  if (!["start", "login", "doctor", "retry"].includes(command)) {
    console.log(
      "pi-pocket-weixin\n  npm run login   Scan a Weixin QR; saves private credentials\n  npm run doctor  Check Pocket auth and local configuration\n  npm start       Start the bridge\n  node src/cli.ts retry  Retry paused deliveries (stop the bridge first)",
    );
    return;
  }
  const dir = dataDirectory();
  privateDirectory(dir);
  if (command === "doctor") {
    const config = loadConfig();
    loadAccount(dir);
    const pocket = new Pocket(config.pocketUrl, config.pocketToken, { signal: controller.signal });
    await pocket.principal();
    console.log(
      "Pocket owner authentication: OK\nWeixin credential file: present (not a live login check)\nRuntime: " +
        process.version +
        "\nData directory: " +
        dir +
        "\nUse /status in Weixin for pending/blocked deliveries. Do not share this directory.",
    );
    return;
  }
  const release = await lockfile.lock(dir, { stale: 30_000, update: 10_000, retries: 0 });
  try {
    if (command === "login") {
      const account = await qrLogin(async (url) => {
        console.log("请用本人的微信扫码并确认。二维码也是敏感信息，请勿分享。\n" + url);
        console.log(await QRCode.toString(url, { type: "terminal", small: true }));
      }, controller.signal);
      saveAccount(dir, account);
      console.log("登录已保存，且只接受扫码关联用户的私聊。配置 .env 后运行 npm start。");
      return;
    }
    const store = new Store(dir);
    try {
      if (command === "retry") {
        store.retryDeliveries();
        console.log(
          "Paused replies queued for retry; restart the bridge. Ambiguous sends may duplicate.",
        );
        return;
      }
      const config = loadConfig();
      const account = loadAccount(dir);
      const scopedLock = join(
        homedir(),
        ".cache/pi-pocket-weixin-locks",
        stableId(account.accountId),
      );
      privateDirectory(scopedLock);
      const releaseAccount = await lockfile.lock(scopedLock, {
        stale: 30_000,
        update: 10_000,
        retries: 0,
      });
      try {
        const pocket = new Pocket(config.pocketUrl, config.pocketToken, {
          publicUrl: config.publicUrl,
          signal: controller.signal,
        });
        const bridge = new Bridge(store, pocket, new ILink(account), account, config);
        await bridge.initialize();
        console.log(
          "Bridge ready: owner-only DM, final replies only. Use /help in Weixin. Ctrl+C stops safely.",
        );
        await bridge.run(controller.signal);
      } finally {
        await releaseAccount();
      }
    } finally {
      store.close();
    }
  } finally {
    await release();
  }
}

try {
  await main();
} catch (error) {
  if (!controller.signal.aborted) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    console.error(
      code === "ELOCKED"
        ? "Another bridge/login owns this data directory or bot credential. Stop it first."
        : error instanceof Error
          ? error.message
          : "Bridge failed",
    );
    process.exitCode = 1;
  }
}
