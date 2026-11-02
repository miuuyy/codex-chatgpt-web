import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import type { CodexMessage } from "../../types";
import { isOnePixelPngDataUrl } from "../../responses/compaction";

interface SavedImage { id: string; url: string; caption: string; }
interface State { version: 1; latest: string; latestTool?: string; accesses?: Record<string, number>; lastAccess?: { action: string; ids: string[] }; active: string[]; images: SavedImage[]; }
export interface ImageContext { threadId: string; active: string[]; }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const imageContextId = (url: string) => `codex-image-${hash(url).slice(0, 24)}`;
function path(threadId: string, root: string): string {
  if (!threadId) throw new Error("Image context requires a thread identity");
  return join(root, `${hash(threadId)}.json`);
}
const defaultRoot = () => join(getConfigDir(), "runtime", "image-context");
function read(threadId: string, root: string): State {
  const file = path(threadId, root);
  if (!existsSync(file)) return { version: 1, latest: "", active: [], images: [] };
  const s = JSON.parse(readFileSync(file, "utf8")) as State;
  if (s.version !== 1 || !Array.isArray(s.images) || !Array.isArray(s.active)) throw new Error("Invalid image context state");
  return s;
}
function write(threadId: string, root: string, state: State): void {
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded) > 100 * 1024 * 1024) throw new Error("Image archive exceeds 100 MiB; start a new task or remove unused image context");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  atomicWriteFile(path(threadId, root), encoded);
}
/** Archive only supplied images. No fetching URLs or inferring authority from captions. */
export function prepareImageContext(threadId: string, messages: readonly CodexMessage[], root = defaultRoot()): ImageContext {
  const state = read(threadId, root);
  let newest: { key: string; ids: string[] } | undefined;
  let newestTool: { key: string; ids: string[]; index: number } | undefined;
  let newestUserIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" || typeof message.content === "string") continue;
    const caption = message.content.filter(p => p.type === "text").map(p => p.text).join("\n").slice(0, 500);
    const images = message.content.filter(p => p.type === "image" && !isOnePixelPngDataUrl(p.imageUrl));
    const ids: string[] = [];
    for (const part of images) {
      if (part.type !== "image") continue;
      const id = imageContextId(part.imageUrl); ids.push(id);
      if (!state.images.some(i => i.id === id)) state.images.push({ id, url: part.imageUrl, caption });
    }
    if (message.role === "user" && ids.length) { newest = { key: hash(JSON.stringify([index, caption, ids])), ids: [...new Set(ids)] }; newestUserIndex = index; }
    if (message.role === "toolResult" && ids.length) newestTool = { key: hash(JSON.stringify([index, caption, ids])), ids, index };
  }
  if (newest && newest.key !== state.latest) { state.latest = newest.key; state.active = newest.ids; }
  if (newestTool && newestTool.index > newestUserIndex && newestTool.key !== state.latestTool) {
    state.active = [...new Set([...state.active, ...newestTool.ids])]; state.latestTool = newestTool.key;
  }
  if (state.active.length > 10) throw new Error("Current image working set exceeds 10 attachments; explicitly select a smaller set");
  if (state.images.length || existsSync(path(threadId, root))) write(threadId, root, state);
  return { threadId, active: [...state.active] };
}
/** Returns original bytes through MCP, isolated by the broker-authenticated thread. */
export function accessImageContext(threadId: string, action: "list" | "get" | "replace" | "add", ids: string[], root = defaultRoot(), offset = 0, limit = 20) {
  const state = read(threadId, root);
  if (ids.length > 10) throw new Error("Request at most 10 images at a time");
  const selected = ids.map(id => { const image = state.images.find(i => i.id === id); if (!image) throw new Error(`Image unavailable in this thread: ${id}`); return image; });
  if (action === "replace" || action === "add") {
    const active = [...new Set(action === "add" ? [...state.active, ...ids] : ids)];
    if (active.length > 10) throw new Error("Image working set exceeds 10 attachments");
    state.active = active; write(threadId, root, state);
  }
  state.accesses = { ...state.accesses, [action]: (state.accesses?.[action] ?? 0) + 1 };
  state.lastAccess = { action, ids }; write(threadId, root, state);
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: JSON.stringify({ active: state.active, images: state.images.slice(offset, offset + limit).map(({ id, caption }) => ({ id, caption })), total: state.images.length, next_offset: offset + limit < state.images.length ? offset + limit : null }) }];
  if (action !== "list") for (const image of selected) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image.url);
    if (!match) content.push({ type: "text", text: `${image.id}: original is not a supported embedded image; it is unavailable through this tool. Ask for reattachment.` });
    else content.push({ type: "image", mimeType: match[1]!, data: match[2]! });
  }
  return { content };
}

/** Pure projection: never rewrite canonical Codex messages. */
export function projectImageContext(messages: readonly CodexMessage[], context: ImageContext): CodexMessage[] {
  return messages.map(message => {
    if (message.role === "assistant" || typeof message.content === "string") return message;
    return { ...message, content: message.content.map(part => part.type === "image" && !isOnePixelPngDataUrl(part.imageUrl) && !context.active.includes(imageContextId(part.imageUrl))
      ? { type: "text" as const, text: `[Historical image ${imageContextId(part.imageUrl)} is not attached. Use codex_tool_call with wire_name codex.image_context and arguments action=get, ids=[this ID] to retrieve it; do not guess its contents.]` } : part) };
  });
}
