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
export function splitText(text: string, limit = 1800): string[] {
  if (limit < 20) throw new Error("Chunk limit is too small");
  const remaining = Array.from(text.trim());
  const chunks: string[] = [];
  let offset = 0;
  while (offset < remaining.length) {
    let end = Math.min(offset + limit, remaining.length);
    if (end < remaining.length) {
      const tail = remaining.slice(offset, end).join("");
      const newline = tail.lastIndexOf("\n");
      if (newline > tail.length / 2) end = offset + Array.from(tail.slice(0, newline + 1)).length;
    }
    chunks.push(remaining.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}
