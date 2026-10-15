import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ilinkBase, pocketBase } from "./http.ts";

export const AccountSchema = z.object({
  accountId: z.string().min(1),
  token: z.string().min(1),
  baseUrl: z.string().transform(ilinkBase),
  peer: z.string().min(1),
});
export type Account = z.infer<typeof AccountSchema>;
export interface Config {
  dataDir: string;
  pocketUrl: string;
  pocketToken: string;
  publicUrl: string;
  newCwd?: string;
  textBatchDelayMs?: number;
}
export function dataDirectory(): string {
  return resolve(process.env.WEIXIN_DATA_DIR || join(homedir(), ".local/share/pi-pocket-weixin"));
}
export function loadConfig(): Config {
  const pocketUrl = pocketBase(process.env.POCKET_URL || "http://127.0.0.1:8080");
  const pocketToken = process.env.POCKET_TOKEN?.trim();
  if (!pocketToken || pocketToken === "replace-with-your-pocket-owner-token") {
    throw new Error("Set POCKET_TOKEN to your Pocket owner's sign-in token (never commit it)");
  }
  return {
    dataDir: dataDirectory(),
    pocketUrl,
    pocketToken,
    publicUrl: pocketBase(process.env.POCKET_PUBLIC_URL || pocketUrl),
    newCwd: process.env.POCKET_NEW_CWD || undefined,
    textBatchDelayMs: z.coerce
      .number()
      .finite()
      .min(0)
      .max(2000)
      .parse(process.env.WEIXIN_TEXT_BATCH_DELAY_MS ?? 300),
  };
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
export function loadAccount(dir: string): Account {
  const path = join(dir, "credentials.json");
  if (!existsSync(path)) throw new Error("No Weixin credentials. Run npm run login first.");
  chmodSync(path, 0o600);
  return AccountSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function saveAccount(dir: string, account: Account): void {
  privateDirectory(dir);
  const path = join(dir, "credentials.json");
  if (existsSync(path)) {
    const previous = loadAccount(dir);
    if (previous.accountId !== account.accountId || previous.peer !== account.peer) {
      throw new Error("This directory belongs to another bot/user. Use a new WEIXIN_DATA_DIR.");
    }
  }
  const temp = join(dir, ".credentials-" + randomUUID());
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(AccountSchema.parse(account), null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  if (process.platform !== "win32") {
    const parent = openSync(dir, "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
}
