import assert from "node:assert/strict";
import { test } from "node:test";
import { splitText } from "../src/format.ts";

test("Markdown paragraphs and normal-sized fences stay together under the code-point ceiling", () => {
  const code = '```ts\nconst value = "🙂";\n```';
  const paragraphs = ["first paragraph", code, "last paragraph"];
  const chunks = splitText(paragraphs.join("\n\n"), 50);
  assert.ok(chunks.some((chunk) => chunk.includes(code)));
  assert.equal(chunks.join("\n\n"), paragraphs.join("\n\n"));
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 50));
});

test("oversized code blocks are closed and reopened without losing Unicode or code whitespace", () => {
  const source = "  🙂 hello  \n".repeat(80).slice(0, -1);
  const chunks = splitText("```ts\n" + source + "\n```", 80);
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every((chunk) => chunk.startsWith("```ts\n") && chunk.endsWith("\n```")),
    "every code chunk must independently close its fence",
  );
  assert.equal(chunks.map((chunk) => chunk.slice(6, -4)).join(""), source);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 80));
});

test("Markdown normalization never collapses blank lines inside code or creates empty messages", () => {
  const result = splitText("one   \n\n\n\n```\na\n\n\nb\n```\n\n\nlast");
  assert.deepEqual(result, ["one\n\n```\na\n\n\nb\n```\n\nlast"]);
  assert.deepEqual(splitText(" \n "), []);
  assert.ok(splitText("```js\n" + "x".repeat(100), 30).every((chunk) => chunk.endsWith("\n```")));
});
