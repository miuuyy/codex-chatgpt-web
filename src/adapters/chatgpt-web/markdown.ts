import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

export function chatGptHtmlToMarkdown(html: string): string {
  return html.trim() ? turndown.turndown(html).trim() : "";
}

export interface ChatGptMarkdownSegment {
  key: string;
  html: string;
  text: string;
  group?: string;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  text: string;
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. The browser supplies semantic blocks and marks a block streamable
 * only after a following block exists. Each completed block must then remain byte-stable for the
 * configured window. Once committed, presentation-only HTML rewrites are harmless; changing its
 * visible text is an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<number, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
    private readonly incremental = true,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    this.assertCommittedPrefix(segments);
    this.latest = segments.map(segment => ({ ...segment }));

    for (let index = this.committed.length; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const previous = this.candidates.get(index);
      const unchanged = previous
        && previous.key === segment.key
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group;
      this.candidates.set(index, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const index of this.candidates.keys()) {
      if (index >= segments.length) this.candidates.delete(index);
    }

    // ChatGPT can revise blocks long after they looked complete, especially after a browser-native
    // search or Python artifact finishes. Responses deltas are append-only, so the browser worker
    // defers final-answer text until response-scoped completion is proven. The incremental mode
    // remains available for isolated serializer tests and consumers with an immutable source.
    if (!this.incremental) return "";

    let delta = "";
    while (this.committed.length < segments.length) {
      const index = this.committed.length;
      const candidate = this.candidates.get(index);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push({ key: candidate.key, text: candidate.text });
      this.candidates.delete(index);
    }
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    this.assertCommittedPrefix(this.latest);
    let delta = "";
    for (let index = this.committed.length; index < this.latest.length; index += 1) {
      const segment = this.latest[index]!;
      delta += this.commit(segment);
      this.committed.push({ key: segment.key, text: segment.text });
    }
    this.candidates.clear();
    return { markdown: this.markdown, delta };
  }

  private assertCommittedPrefix(segments: ChatGptMarkdownSegment[]): void {
    if (segments.length < this.committed.length) {
      throw new Error("ChatGPT removed a completed text block that was already streamed to Codex");
    }
    for (let index = 0; index < this.committed.length; index += 1) {
      const previous = this.committed[index]!;
      const current = segments[index]!;
      if (current.key !== previous.key || current.text !== previous.text) {
        throw new Error("ChatGPT changed a completed text block that was already streamed to Codex");
      }
    }
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
