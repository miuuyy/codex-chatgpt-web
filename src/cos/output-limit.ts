const DEFAULT_LIMIT = 1024 * 1024;

function prefix(bytes: Buffer, count: number): Buffer {
  let end = Math.min(bytes.length, count);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}
function suffix(bytes: Buffer, count: number): Buffer {
  let start = Math.max(0, bytes.length - count);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

/** Bound UTF-8 text while retaining both ends; never split a Unicode code point. */
export function limitOutputText(text: string, maxBytes = DEFAULT_LIMIT): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Output limit must be a nonnegative byte count");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let marker = `\n... ${bytes.length} bytes omitted ...\n`;
  if (maxBytes < Buffer.byteLength(marker)) return prefix(bytes, maxBytes).toString("utf8");
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
    const head = prefix(bytes, Math.floor(budget / 2));
    const tail = suffix(bytes, budget - head.length);
    const next = `\n... ${bytes.length - head.length - tail.length} bytes omitted ...\n`;
    if (Buffer.byteLength(next) <= Buffer.byteLength(marker)) return Buffer.concat([head, Buffer.from(next), tail]).toString("utf8");
    marker = next;
  }
  throw new Error("Output omission marker failed to stabilize");
}

export function limitMcpTextContent(content: unknown[], maxBytes = DEFAULT_LIMIT): unknown[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Output limit must be a nonnegative byte count");
  const isText = (item: unknown): item is { type: "text"; text: string } => Boolean(item && typeof item === "object"
    && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string");
  const texts = content.filter(isText);
  const total = texts.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0);
  if (total <= maxBytes) return content;
  let budget = maxBytes;
  let remaining = total;
  return content.map(item => {
    if (!isText(item)) return item;
    const size = Buffer.byteLength(item.text, "utf8");
    const allocation = remaining === 0 ? 0 : Math.floor(budget * size / remaining);
    const text = limitOutputText(item.text, allocation);
    budget -= Buffer.byteLength(text, "utf8");
    remaining -= size;
    return { ...item, text };
  });
}
