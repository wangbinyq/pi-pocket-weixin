import { createHash } from "node:crypto";

export function stableId(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
export function oneLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function plainChunks(text: string, limit: number): string[] {
  const remaining = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < remaining.length) {
    let end = Math.min(offset + limit, remaining.length);
    if (end < remaining.length) {
      const tail = remaining.slice(offset, end);
      const newline = tail.lastIndexOf("\n");
      if (newline > tail.length / 2) end = offset + newline + 1;
    }
    chunks.push(remaining.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}
export function splitText(text: string, limit = 1800): string[] {
  if (limit < 20) throw new Error("Chunk limit is too small");
  const blocks: { text: string; fence?: string }[] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (lines.length) blocks.push({ text: lines.join("\n"), ...(fence ? { fence } : {}) });
    lines = [];
  };
  for (const raw of text.trim().split("\n")) {
    const marker = /^```([^`\n]*)$/.exec(raw.trim());
    if (marker && !fence) {
      flush();
      fence = raw.trim();
    } else if (marker && fence) {
      flush();
      fence = undefined;
    } else if (fence || raw.trim()) {
      lines.push(fence ? raw : raw.trimEnd());
    } else {
      flush();
    }
  }
  flush();
  const units = blocks.flatMap((block) => {
    if (!block.fence) return plainChunks(block.text, limit);
    const opening = Array.from(block.fence)
      .slice(0, Math.min(60, limit - 10))
      .join("");
    const capacity = limit - Array.from(opening).length - 5;
    return plainChunks(block.text || " ", capacity).map((chunk) => `${opening}\n${chunk}\n\`\`\``);
  });
  const chunks: string[] = [];
  for (const unit of units) {
    const last = chunks.at(-1);
    if (last && Array.from(last).length + Array.from(unit).length + 2 <= limit)
      chunks[chunks.length - 1] = last + "\n\n" + unit;
    else chunks.push(unit);
  }
  return chunks;
}
