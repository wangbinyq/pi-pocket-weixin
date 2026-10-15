import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { Pocket } from "../src/pocket.ts";
import { account, fixture } from "./helpers.ts";

const source = process.env.POCKET_SOURCE;

test(
  "real Pocket API: PiP, switching, idempotent input, final replies and /new",
  { skip: !source, timeout: 90_000 },
  async (t) => {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.2");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>((done, reject) =>
      reservation.close((error) => (error ? reject(error) : done())),
    );
    const child = spawn(process.execPath, ["test/serve.ts", String(address.port), "127.0.0.2"], {
      cwd: resolve(source!),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    });
    const login = await new Promise<URL>((done, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Isolated Pocket did not start in 40 seconds")),
        40_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /owner: (http:\/\/[^\s]+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          done(new URL(match[1]!));
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Isolated Pocket exited before startup"));
      });
    });
    const token = login.searchParams.get("token");
    assert.ok(token);
    const pocket = new Pocket(login.origin, token);
    const sessions = await pocket.sessions();
    const first = sessions[0]!;
    const f = fixture(t);
    const config = {
      ...f.config,
      pocketUrl: login.origin,
      pocketToken: token,
      publicUrl: login.origin,
    };
    const bridge = new Bridge(f.store, pocket, f.weixin, account, config, () => {});
    await bridge.initialize();
    const pipId = f.store.target()!.id;
    assert.notEqual(pipId, first.id);
    f.input(`/use ${first.id}`);
    assert.equal(await bridge.processNext(), true);
    assert.equal(f.store.target()?.id, first.id);
    const baseline = await pocket.head(first.id);
    await pocket.submit(first.id, "integration idempotent task", "integration-stable-request");
    await pocket.submit(first.id, "integration idempotent task", "integration-stable-request");
    const waitForReply = async (id: number, after: number) => {
      for (let n = 0; n < 100; n++) {
        const entries = await pocket.after(id, after);
        if (entries.some((entry) => entry.kind === "assistant" && entry.stopReason === "stop"))
          return entries;
        await sleep(100);
      }
      throw new Error("Scripted model did not finish");
    };
    const entries = await waitForReply(first.id, baseline);
    assert.equal(entries.filter((entry) => entry.kind === "user").length, 1);
    await bridge.collect();
    while (await bridge.deliverNext()) {
      /* drain into the fake Weixin transport */
    }
    assert.ok(
      f.weixin.sent.some((entry) => /echo:[\s\S]*integration idempotent task/.test(entry.text)),
    );
    f.input("/pip");
    await bridge.processNext();
    assert.equal(f.store.target()?.id, pipId);
    f.input("hello from Weixin");
    await bridge.processNext();
    await waitForReply(pipId, 0);
    await bridge.collect();
    while (await bridge.deliverNext()) {
      /* drain */
    }
    assert.ok(f.weixin.sent.some((entry) => /echo:[\s\S]*hello from Weixin/.test(entry.text)));
    f.input("/new integration project");
    await bridge.processNext();
    const created = (await pocket.sessions()).find(
      (entry) => entry.title === "integration project",
    );
    assert.ok(created);
    assert.equal(f.store.target()?.id, created.id);
  },
);
