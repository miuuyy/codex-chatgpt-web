import type { Page } from "playwright-core";

/**
 * ChatGPT's bundled micromark GFM email tokenizer scans the complete event history
 * before it even knows whether an atext run contains '@'. A large escaped JSON
 * message makes these failed email attempts quadratic. Defer that check until an
 * '@' is actually present, using exactly the pre-attempt event prefix.
 *
 * Only a narrowly recognized tokenizer is changed. Text, requests, authentication,
 * model selection and the assistant's Markdown are not rewritten.
 * Upstream algorithm: micromark-extension-gfm-autolink-literal/lib/syntax.js.
 */
export function patchAutolinkEmailCheck(source: string): { source: string; patched: boolean } {
  const starts = /function (\w+)\((\w+),(\w+),(\w+)\)\{let (\w+)=this,(\w+),(\w+);return (\w+);/g;
  const candidates: Array<{ start: number; end: number; replacement: string }> = [];
  for (const match of source.matchAll(starts)) {
    const start = match.index!;
    let end = start + match[0].indexOf("{");
    let depth = 0;
    let quote = "";
    for (; end < Math.min(source.length, start + 2000); end++) {
      const c = source[end]!;
      if (quote) {
        if (c === "\\") { end++; continue; }
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end++; break; }
    }
    if (depth !== 0) continue;
    const body = source.slice(start, end);
    const [, , effects, , nok, self, , , entry] = match;
    if (!new RegExp(`${effects}\\.enter\\([\\x60'"]literalAutolinkEmail[\\x60'"]\\)`).test(body)
      || body.includes("__codexEmailEvents") || body.includes("${")) continue;
    const guard = new RegExp(`\\|\\|(\\w+)\\(${self}\\.events\\)`).exec(body);
    const entryHeader = new RegExp(`function ${entry}\\((\\w+)\\)`).exec(body);
    if (!guard || !entryHeader) continue;
    const previous = guard[1]!;
    const code = entryHeader[1]!;
    if (!source.includes(`function ${previous}(`) || !source.includes("_gfmAutolinkLiteralWalkedInto")) continue;
    const enter = new RegExp(`${effects}\\.enter\\([\\x60'"]literalAutolink[\\x60'"]\\)`).exec(body)?.[0];
    const at = new RegExp(`${code}===(?:64|\\w+\\.atSign)`).exec(body)?.[0];
    if (!enter || !at) continue;
    const replacement = body
      .replace(`;return ${entry};`, `;let __codexEmailEvents;return ${entry};`)
      .replace(guard[0], "")
      .replace(enter, `__codexEmailEvents=${self}.events.length,${enter}`)
      .replace(at, `${at}&&!${previous}(${self}.events.slice(0,__codexEmailEvents))`);
    candidates.push({ start, end, replacement });
  }
  if (candidates.length !== 1) return { source, patched: false };
  const change = candidates[0]!;
  return { source: source.slice(0, change.start) + change.replacement + source.slice(change.end), patched: true };
}

const bundlePattern = /^https:\/\/(?:chatgpt\.com\/cdn|cdn\.oaistatic\.com)\/assets\/conversation-small-[a-zA-Z0-9_-]+\.js(?:\?.*)?$/;

export async function installAutolinkRenderCompatibility(
  page: Page, options: { nextDocument?: boolean } = {},
): Promise<() => Promise<void>> {
  // A retained document was already initialized on its first turn.
  if (!options.nextDocument && await page.evaluate(() => (globalThis as { __CODEX_AUTOLINK_COMPAT__?: boolean }).__CODEX_AUTOLINK_COMPAT__ === true)) {
    return async () => {};
  }
  const session = await page.context().newCDPSession(page);
  const urls = new Map<string, string>();
  let closing = false;
  let breakpointId: string | undefined;
  const detach = async () => {
    closing = true; urls.clear();
    await session.detach().catch(() => {});
  };
  session.on("Debugger.scriptParsed", event => { if (bundlePattern.test(event.url)) urls.set(event.scriptId, event.url); });
  session.on("Debugger.paused", event => {
    if (!breakpointId || !event.hitBreakpoints?.includes(breakpointId)) return;
    void (async () => {
      try {
        const frame = event.callFrames[0];
        if (!frame || !bundlePattern.test(urls.get(frame.location.scriptId) ?? "")) return;
        const { scriptSource } = await session.send("Debugger.getScriptSource", { scriptId: frame.location.scriptId });
        const changed = patchAutolinkEmailCheck(scriptSource);
        if (!changed.patched) {
          console.warn("[chatgpt-web] autolink-render compatibility: tokenizer signature not recognized");
          return;
        }
        // Only the recognized function declaration differs. Extract its replacement
        // and initialize that module-local binding before the module registers it.
        let prefix = 0; while (prefix < scriptSource.length && scriptSource[prefix] === changed.source[prefix]) prefix++;
        const functionStart = scriptSource.lastIndexOf("function ", prefix);
        const header = /^function (\w+)\(/.exec(scriptSource.slice(functionStart));
        // The changed declaration contains nested functions; find its balanced end.
        let depth = 0, quote = "", end = changed.source.indexOf("{", functionStart);
        for (; end < changed.source.length; end++) {
          const c = changed.source[end]!;
          if (quote) { if (c === "\\") end++; else if (c === quote) quote = ""; }
          else if (c === "'" || c === '"' || c === "`") quote = c;
          else if (c === "{") depth++;
          else if (c === "}" && --depth === 0) { end++; break; }
        }
        if (!header || depth !== 0) throw new Error("Invalid autolink replacement boundary");
        const replacement = changed.source.slice(functionStart, end);
        const result = await session.send("Debugger.evaluateOnCallFrame", {
          callFrameId: frame.callFrameId,
          expression: `${header[1]} = (${replacement}); globalThis.__CODEX_AUTOLINK_COMPAT__ = true;`,
          returnByValue: true,
          silent: true,
        });
        if (result.exceptionDetails) throw new Error("Autolink module initialization failed");
        console.info("[chatgpt-web] autolink-render compatibility: deferred email history check installed");
      } catch (error) {
        if (!closing) console.warn(`[chatgpt-web] autolink-render compatibility unavailable: ${error instanceof Error ? error.message : "Error"}`);
      } finally {
        await session.send("Debugger.resume").catch(() => {});
        await detach();
      }
    })();
  });
  await session.send("Debugger.enable");
  ({ breakpointId } = await session.send("Debugger.setBreakpointByUrl", {
    urlRegex: bundlePattern.source, lineNumber: 0, columnNumber: 0,
  }));
  return async () => {
    closing = true;
    await session.send("Debugger.resume").catch(() => {});
    await detach();
  };
}
