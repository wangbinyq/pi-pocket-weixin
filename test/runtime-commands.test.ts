import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { Pocket } from "../src/pocket.ts";
import { HttpError, type Fetcher } from "../src/http.ts";
import { ILink } from "../src/ilink.ts";
import { Store } from "../src/store.ts";
import { account, fixture } from "./helpers.ts";

test("/stop bypasses only preceding ordinary input, keeps later input and never stops another session", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("discard this task");
  f.input("/stop");
  f.input("explicit task after stop");
  f.pocket.active = [
    { id: 1, title: "PiP", busy: true, approvals: 0 },
    { id: 2, title: "other", busy: true, approvals: 0 },
  ];
  await f.bridge.processNext();
  assert.deepEqual(f.pocket.stops, [1]);
  assert.equal(f.pocket.requests.size, 0);
  assert.equal(f.store.job()?.text, "explicit task after stop");
  assert.equal(f.pocket.active[0]?.id, 2);
  assert.match(f.store.delivery()?.text || "", /已停止/);
  await f.bridge.processNext();
  assert.deepEqual(
    [...f.pocket.requests.values()].map((entry) => entry.text),
    ["explicit task after stop"],
  );
});

test("/stop never crosses a pending route-change command", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  for (const text of ["earlier task", "/resume 2", "/stop"]) f.input(text);
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 1);
  await f.bridge.processNext();
  await f.bridge.processNext();
  assert.deepEqual(f.pocket.stops, [2]);
});

for (const command of ["/stop", "/model test/model high"]) {
  test(`${command}: response loss or crash never repeats a non-idempotent control request`, async (t) => {
    const f = fixture(t);
    await f.bridge.initialize();
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error("response lost");
    };
    f.pocket.stop = fail;
    f.pocket.model = fail;
    f.input(command);
    await f.bridge.processNext();
    await f.bridge.processNext();
    assert.equal(calls, 1);
    assert.equal(f.store.job(), undefined);
    assert.match(f.store.delivery()?.text || "", /结果不确定/);
    f.input(command);
    const job = f.store.job()!;
    const intent = command === "/stop" ? "stopIntent" : "modelIntent";
    f.store.set(intent, job.key);
    const reopened = new Store(f.dir);
    try {
      const bridge = new Bridge(reopened, f.pocket, f.weixin, account, f.config, () => {});
      await bridge.initialize();
      await bridge.processNext();
      assert.equal(calls, 1);
      assert.equal(reopened.job(), undefined);
      assert.equal(reopened.get(intent), "");
    } finally {
      reopened.close();
    }
  });
}

test("/model only changes the explicit current session and validates provider, level and sign-in", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  for (const command of [
    "/model",
    "/model missing/model",
    "/model test/model impossible",
    "/model test/model high extra",
  ]) {
    f.input(command);
    await f.bridge.processNext();
  }
  assert.equal(f.pocket.modelChanges.length, 0);
  f.pocket.availableModels[0]!.signIn = true;
  f.input("/model test/model");
  await f.bridge.processNext();
  assert.equal(f.pocket.modelChanges.length, 0);
  f.pocket.availableModels[0]!.signIn = false;
  f.input("/resume 2");
  await f.bridge.processNext();
  f.input("/model test/model high");
  await f.bridge.processNext();
  assert.deepEqual(f.pocket.modelChanges, [
    { id: 2, provider: "test", modelId: "model", thinkingLevel: "high" },
  ]);
  assert.equal(f.pocket.requests.size, 0);
  assert.equal(f.pocket.stops.length, 0);
});

test("busy modes persist, queue remains default, steer is native and interrupt stops before submit", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("queued");
  await f.bridge.processNext();
  f.input("/busy steer");
  await f.bridge.processNext();
  f.input("steered");
  await f.bridge.processNext();
  f.input("/busy interrupt");
  await f.bridge.processNext();
  const reopened = new Store(f.dir);
  try {
    assert.equal(reopened.get("busyMode"), "interrupt");
  } finally {
    reopened.close();
  }
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 0 }];
  const submit = f.pocket.submit.bind(f.pocket);
  f.pocket.submit = async (...args) => {
    assert.deepEqual(f.pocket.stops, [1]);
    await submit(...args);
  };
  f.input("replacement");
  await f.bridge.processNext();
  assert.deepEqual(f.pocket.modes, ["followUp", "steer", "followUp"]);
  assert.equal(f.store.target()?.id, 1);
  f.input("/busy invalid");
  await f.bridge.processNext();
  assert.equal(f.store.get("busyMode"), "interrupt");
});

test("interrupt ambiguity never submits; confirmed stop followed by submit retry never stops twice", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.store.set("busyMode", "interrupt");
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 0 }];
  const stop = f.pocket.stop.bind(f.pocket);
  f.pocket.stop = async (id) => {
    await stop(id);
    throw new Error("lost stop response");
  };
  f.input("not safe to send");
  await f.bridge.processNext();
  assert.equal(f.pocket.requests.size, 0);
  assert.equal(f.store.job(), undefined);
  assert.match(f.store.delivery()?.text || "", /结果不确定/);
  f.pocket.stop = stop;
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 0 }];
  f.pocket.failSubmit = true;
  f.input("submit retry");
  await f.bridge.processNext();
  const key = f.store.job()!.key;
  assert.equal(f.store.get("interruptStopped"), key);
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 0 }];
  f.pocket.failSubmit = false;
  f.store.db.exec("UPDATE inbox SET due=0");
  await f.bridge.processNext();
  assert.deepEqual(f.pocket.stops, [1, 1]);
  assert.equal(f.pocket.requests.size, 1);
  assert.equal(f.pocket.calls.at(-1), key);
});

test("definite control refusals do not succeed or repeat and changed principals cannot control sessions", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.pocket.stop = async () => {
    throw new HttpError("Pocket", 403);
  };
  f.input("/stop");
  await f.bridge.processNext();
  assert.match(f.store.delivery()?.text || "", /HTTP 403/);
  assert.equal(f.store.get("stopIntent"), "");
  f.pocket.user = "changed-owner";
  for (const command of ["/stop", "/model test/model", "/busy interrupt"]) f.input(command);
  await f.bridge.processNext();
  assert.equal(f.pocket.stops.length, 0);
  assert.equal(f.pocket.modelChanges.length, 0);
  assert.equal(f.store.get("busyMode"), undefined);
});

test("typing begins, stops for approvals, refreshes and never blocks task submission on failure", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  f.input("task");
  await f.bridge.processNext();
  assert.deepEqual(f.weixin.typingStates, [true]);
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 1 }];
  await f.bridge.collect();
  assert.deepEqual(f.weixin.typingStates, [true, false]);
  f.pocket.active[0]!.approvals = 0;
  await f.bridge.collect();
  await f.bridge.collect();
  assert.deepEqual(f.weixin.typingStates, [true, false, true]);
  f.input("/resume 2");
  await f.bridge.processNext();
  assert.equal(f.weixin.typingStates.at(-1), false);
  f.weixin.typing = async () => {
    throw new Error("typing failed");
  };
  f.input("still sent");
  await f.bridge.processNext();
  assert.equal(f.store.job(), undefined);
  assert.equal(f.pocket.requests.size, 2);
});

test("typing heartbeats while the session stays busy, so the indicator never expires", async (t) => {
  const f = fixture(t);
  await f.bridge.initialize();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  f.input("task");
  await f.bridge.processNext();
  assert.deepEqual(f.weixin.typingStates, [true]);
  f.pocket.active = [{ id: 1, title: "PiP", busy: true, approvals: 0 }];
  await f.bridge.collect();
  assert.deepEqual(f.weixin.typingStates, [true], "one heartbeat is not re-sent twice");
  t.mock.timers.tick(2000);
  await f.bridge.collect();
  await f.bridge.collect();
  assert.deepEqual(
    f.weixin.typingStates,
    [true, true],
    "the platform state is refreshed on the next heartbeat",
  );
  f.pocket.active = [];
  await f.bridge.collect();
  assert.deepEqual(f.weixin.typingStates, [true, true, false]);
});

test("typing ticket is prefetched at intake and reused instead of fetched while busy", async () => {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    const endpoint = String(url).split("/").pop();
    calls.push(endpoint || "");
    return Response.json(
      endpoint === "getupdates"
        ? { ret: 0, msgs: [{ message_id: "1" }], get_updates_buf: "next" }
        : { ret: 0, typing_ticket: "prefetched" },
    );
  };
  const ilink = new ILink(account, fetcher, () => {});
  await ilink.updates("");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["getupdates", "getconfig"], "intake warms the ticket before any typing");
  await ilink.typing(account.peer, true);
  assert.deepEqual(calls, ["getupdates", "getconfig", "sendtyping"], "typing reuses it");
});

test("a missing typing ticket is logged, never sent, and retried on the next attempt", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const ilink = new ILink(
    account,
    async (url) => {
      calls.push(String(url).split("/").pop() || "");
      return Response.json({ ret: 0 });
    },
    (message) => logs.push(message),
  );
  await ilink.typing(account.peer, true, "context");
  assert.deepEqual(calls, ["getconfig"], "nothing is sent without a ticket");
  assert.ok(logs.some((line) => line.includes("typing ticket unavailable")));
  assert.ok(logs.every((line) => !line.includes("context") && !line.includes(account.token)));
  await ilink.typing(account.peer, false, "context");
  assert.deepEqual(calls, ["getconfig", "getconfig"], "the next attempt retries instead of no-op");
});

test("typing wire fields match Hermes and ticket is reused without exposing credentials", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const ilink = new ILink(account, async (url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json(
      String(url).endsWith("getconfig") ? { typing_ticket: "ticket" } : { ret: 0 },
    );
  });
  await ilink.typing(account.peer, true, "context");
  await ilink.typing(account.peer, false, "context");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.body, {
    ilink_user_id: account.peer,
    context_token: "context",
    base_info: { channel_version: "2.2.0" },
  });
  assert.deepEqual(
    calls.slice(1).map((c) => c.body.status),
    [1, 2],
  );
  assert.ok(
    calls.slice(1).every((c) => c.url.endsWith("sendtyping") && c.body.typing_ticket === "ticket"),
  );
});

test("Pocket model and stop use native authenticated routes and wait for busy state to end", async () => {
  const calls: { path: string; body?: unknown }[] = [];
  let running = 0;
  const pocket = new Pocket("https://pocket.example.com", "token", {
    fetcher: async (url, init) => {
      assert.equal(new Headers(init?.headers).get("X-Pocket"), "1");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer token");
      const path = new URL(String(url)).pathname;
      calls.push({
        path,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      });
      if (path.endsWith("running"))
        return Response.json(running++ ? [] : [{ id: 2, title: "work", busy: true, approvals: 0 }]);
      return Response.json({ ok: true });
    },
  });
  await pocket.model(2, "test", "model", "high");
  await pocket.stop(2);
  assert.deepEqual(calls[0], {
    path: "/api/c/2/configure",
    body: { model: { provider: "test", modelId: "model" }, thinkingLevel: "high" },
  });
  assert.deepEqual(calls[1], { path: "/api/c/2/abort", body: {} });
  assert.equal(running, 2);
});
