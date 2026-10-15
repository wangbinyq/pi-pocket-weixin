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
  "real Pocket API: routing, idempotency, reset, stop, models, busy modes, media and new sessions",
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
    const pipDiagnostic = await pocket.diagnostics(pipId);
    assert.ok(pipDiagnostic.model);
    assert.ok(pipDiagnostic.contextWindow! > 0);
    f.input(`/resume ${first.id}`);
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
    const diagnostic = await pocket.diagnostics(first.id);
    assert.ok(diagnostic.model);
    assert.ok(diagnostic.contextTokens! > 0);
    assert.ok(diagnostic.contextWindow! > 0);
    f.input("/status");
    await bridge.processNext();
    await bridge.collect();
    while (await bridge.deliverNext()) {
      /* drain into the fake Weixin transport */
    }
    assert.ok(
      f.weixin.sent.some((entry) => /echo:[\s\S]*integration idempotent task/.test(entry.text)),
    );
    const models = await pocket.models();
    const vision = models.find((model) => model.images && !model.signIn)!;
    assert.ok(vision);
    f.input(`/model ${vision.provider}/${vision.id} off`);
    await bridge.processNext();
    assert.equal(f.store.get("modelIntent"), "");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const imageBaseline = await pocket.head(first.id);
    f.weixin.downloadData = image;
    f.store.ingest(account, "image-cursor", [
      {
        messageId: "image-integration",
        peer: account.peer,
        text: "inspect this image",
        unsupported: false,
        media: [{ kind: "image", name: "image.png", query: "fixture" }],
      },
    ]);
    await bridge.processNext();
    const imageEntries = await waitForReply(first.id, imageBaseline);
    const imageEntry = imageEntries.find((entry) => entry.kind === "user");
    assert.ok(imageEntry);
    const storedImage = await fetch(`${login.origin}/api/c/${first.id}/image/${imageEntry.id}/0`, {
      headers: { Authorization: `Bearer ${token}`, "X-Pocket": "1" },
      redirect: "error",
    });
    assert.equal(storedImage.status, 200);
    assert.deepEqual(Buffer.from(await storedImage.arrayBuffer()), image);
    f.input("/busy steer");
    await bridge.processNext();
    assert.equal(f.store.get("busyMode"), "steer");
    const steerBaseline = await pocket.head(first.id);
    f.input("steered integration task");
    await bridge.processNext();
    await waitForReply(first.id, steerBaseline);
    f.input("/busy queue");
    await bridge.processNext();
    f.input("/stop");
    await bridge.processNext();
    assert.equal(f.store.get("stopIntent"), "");
    assert.equal(
      (await pocket.running()).some((entry) => entry.id === first.id && entry.busy),
      false,
    );
    const resetBaseline = await pocket.head(first.id);
    const sessionCount = (await pocket.sessions()).length;
    f.input("/reset 保留目标，但不保留旧对话");
    await bridge.processNext();
    assert.equal(f.store.target()?.id, first.id);
    assert.equal((await pocket.sessions()).length, sessionCount);
    assert.ok(
      (await pocket.after(first.id, resetBaseline)).some((entry) => entry.kind === "reset"),
    );
    assert.ok((await pocket.after(first.id, 0)).some((entry) => entry.id === entries[0]!.id));
    const afterReset = await pocket.head(first.id);
    f.input("task in the new context");
    await bridge.processNext();
    await waitForReply(first.id, afterReset);
    await bridge.collect();
    while (await bridge.deliverNext()) {}
    assert.ok(
      f.weixin.sent.some((entry) => /echo:[\s\S]*task in the new context/.test(entry.text)),
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
    const pipResetBaseline = await pocket.head(pipId);
    f.input("/reset");
    await bridge.processNext();
    assert.equal(f.store.target()?.id, pipId);
    assert.ok(
      (await pocket.after(pipId, pipResetBaseline)).some((entry) => entry.kind === "reset"),
    );
    const inactiveHead = await pocket.head(first.id);
    await pocket.submit(
      first.id,
      "inactive conversation must stay on web",
      "integration-inactive-request",
    );
    await waitForReply(first.id, inactiveHead);
    await bridge.collect();
    while (await bridge.deliverNext()) {}
    assert.ok(
      f.weixin.sent.every(
        (entry) => !entry.text.includes("inactive conversation must stay on web"),
      ),
    );
    f.input(`/resume ${first.id}`);
    await bridge.processNext();
    await bridge.collect();
    while (await bridge.deliverNext()) {}
    assert.ok(
      f.weixin.sent.every(
        (entry) => !entry.text.includes("inactive conversation must stay on web"),
      ),
    );
    assert.deepEqual(
      f.store.watches().map((watch) => watch.id),
      [first.id],
    );
    f.input("/new integration project");
    await bridge.processNext();
    const created = (await pocket.sessions()).find(
      (entry) => entry.title === "integration project",
    );
    assert.ok(created);
    assert.equal(f.store.target()?.id, created.id);
  },
);
