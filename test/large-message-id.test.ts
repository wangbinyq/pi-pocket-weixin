import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge } from "../src/bridge.ts";
import { ILink, incomingFor } from "../src/ilink.ts";
import { account, fixture } from "./helpers.ts";

const wire = (id: string, sender = account.peer) =>
  `{"message_id":${id},"from_user_id":${JSON.stringify(sender)},"to_user_id":${JSON.stringify(account.accountId)},"message_type":1,"item_list":[{"type":1,"text_item":{"text":"/help"}}],"context_token":"test-context"}`;

test("iLink preserves distinct 64-bit numeric message IDs before JSON rounding", async () => {
  const ids = [
    "9007199254740991",
    "9007199254740993",
    "9223372036854775806",
    "9223372036854775807",
    "18446744073709551615",
  ];
  const api = new ILink(
    account,
    async () =>
      new Response(`{"msgs":[${ids.map((id) => wire(id)).join(",")}],"get_updates_buf":"next"}`),
  );
  const batch = await api.updates("");
  assert.deepEqual(
    batch.messages.map((msg) => incomingFor(msg, account)?.messageId),
    ids,
  );
});

test("large-ID wire messages reach the durable inbox once each, not zero or one merged message", async (t) => {
  const f = fixture(t);
  const ids = ["9223372036854775806", "9223372036854775807"];
  const api = new ILink(
    account,
    async () =>
      new Response(`{"msgs":[${ids.map((id) => wire(id)).join(",")}],"get_updates_buf":"next"}`),
  );
  const logs: string[] = [];
  const bridge = new Bridge(
    f.store,
    f.pocket,
    {
      updates: (cursor, signal) => api.updates(cursor, signal),
      send: (peer, text, clientId, context) => f.weixin.send(peer, text, clientId, context),
    },
    account,
    f.config,
    (message) => logs.push(message),
  );
  await bridge.initialize();
  await bridge.receive();
  await bridge.receive();
  assert.equal(f.store.counts().inbox, 2);
  assert.equal(f.store.get("contextToken"), "test-context");
  await bridge.processNext();
  await bridge.processNext();
  while (await bridge.deliverNext()) {}
  assert.equal(f.weixin.sent.length, 2);
  assert.equal(new Set(f.weixin.sent.map((message) => message.clientId)).size, 2);
  assert.ok(logs.some((line) => line.includes("accepted=2")));
  assert.ok(logs.every((line) => !line.includes("test-context") && !line.includes("/help")));
});

test("lossless IDs do not weaken sender checks, and already rounded inputs remain rejected", async () => {
  const api = new ILink(
    account,
    async () =>
      new Response(
        `{"msgs":[${wire("9223372036854775807", "stranger")}],"get_updates_buf":"next"}`,
      ),
  );
  assert.equal(incomingFor((await api.updates("")).messages[0], account), undefined);
  assert.equal(incomingFor(JSON.parse(wire("9223372036854775807")), account), undefined);
});

test("numeric-looking text and quoted IDs are not rewritten by the lossless parser", async () => {
  const payload = {
    msgs: [
      {
        message_id: "0009223372036854775807",
        from_user_id: account.peer,
        item_list: [{ type: 1, text_item: { text: '{"message_id":9223372036854775807}' } }],
      },
    ],
  };
  const api = new ILink(account, async () => Response.json(payload));
  const msg = incomingFor((await api.updates("")).messages[0], account);
  assert.equal(msg?.messageId, "0009223372036854775807");
  assert.equal(msg?.text, '{"message_id":9223372036854775807}');
});
