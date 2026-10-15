import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
let version = "unknown";
try {
  const pkg = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
  let revision = "unknown";
  try {
    revision = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* Source archives may not contain git metadata. */
  }
  version = `${pkg.version}+${revision}`;
} catch {
  /* Missing package metadata is reported, not guessed. */
}
export const bridgeVersion = version;
