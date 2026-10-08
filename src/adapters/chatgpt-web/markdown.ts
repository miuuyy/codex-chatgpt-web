import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { createDocument } from "@mixmark-io/domino";

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
turndown.addRule("preserveCodexPlanBlockTags", {
  filter: "p",
  replacement: content => {
    // Codex recognizes these standalone control lines verbatim. Restore only paragraph text:
    // a post-conversion replacement would also rewrite literal escapes in fenced code.
    const paragraph = content.replace(/^([ \t]*)<(\/?)proposed\\_plan>([ \t]*)$/gm, "$1<$2proposed_plan>$3");
    return `\n\n${paragraph}\n\n`;
  },
});
turndown.addRule("linkInlineFilePaths", {
  filter: node => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent!;
    const target = path.replaceAll("\\", "/");
    // Code text becomes a plain link label, where backslashes and emphasis must be escaped.
    return `[${turndown.escape(path)}](<${target}>)`;
  },
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
turndown.addRule("preserveKatexSource", {
  filter: node => node.classList.contains("katex") && node.hasAttribute("data-codex-latex"),
  replacement: (_content, node) => {
    const source = (node as HTMLElement).getAttribute("data-codex-latex")!;
    return node.parentElement?.classList.contains("katex-display")
      ? `\n\n\\[\n${source}\n\\]\n\n`
      : `\\(${source}\\)`;
  },
});

function preserveKatexSource(html: string): string | HTMLElement {
  if (!html.includes("katex")) return html;
  const root = createDocument().createElement("div");
  root.innerHTML = html;
  for (const math of Array.from(root.querySelectorAll(".katex"))) {
    if (math.closest("pre, code")) continue;
    const sources = math.querySelectorAll('annotation[encoding="application/x-tex"]');
    if (sources.length !== 1) throw new Error("ChatGPT formula does not contain one unambiguous LaTeX source");
    const source = sources[0]!.textContent ?? "";
    // Capture before Turndown collapses whitespace: newlines matter in TeX
    // comments. Carry the source as data while removing the duplicated MathML
    // and visual layers from this conversion-only DOM.
    math.setAttribute("data-codex-latex", source);
    math.textContent = source;
  }
  return root;
}

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== "CODE") return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["A", "PRE"].includes(ancestor.nodeName)) return undefined;
  }

  const path = node.textContent ?? "";
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;

  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const separator = Math.max(withoutLocation.lastIndexOf("/"), withoutLocation.lastIndexOf("\\"));
  if (separator < 0) return undefined;

  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

function obsidianWikiLink(value: string): string | undefined {
  const separator = value.indexOf("|");
  const target = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const label = (separator >= 0 ? value.slice(separator + 1) : value).trim();
  if (!target || !label || /[<>]/.test(target)) return undefined;

  const fragmentAt = target.indexOf("#");
  const note = fragmentAt >= 0 ? target.slice(0, fragmentAt) : target;
  const fragment = fragmentAt >= 0 ? target.slice(fragmentAt) : "";
  const extension = note.slice(note.lastIndexOf("/") + 1).includes(".");
  const path = note && !extension ? `${note}.md` : note;
  return `[${label}](<${path}${fragment}>)`;
}

function linkObsidianWikiLinks(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let mathEnd: "\\)" | "\\]" | undefined;
  return markdown.split("\n").map(line => {
    const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const closingRun = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = undefined;
      return line;
    }
    if (!mathEnd && fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      return line;
    }

    let result = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (mathEnd) {
        const end = line.indexOf(mathEnd, index);
        if (end < 0) return result + line.slice(index);
        result += line.slice(index, end + mathEnd.length);
        index = end + mathEnd.length;
        mathEnd = undefined;
        continue;
      }
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineCodeTicks = inlineCodeTicks === 0 ? ticks : ticks === inlineCodeTicks ? 0 : inlineCodeTicks;
        result += line.slice(index, end);
        index = end;
        continue;
      }
      // Restore Turndown-escaped wiki brackets only in prose, never inside a
      // formula or code example. Double brackets can be valid LaTeX content.
      const escapedWiki = line.startsWith("\\[\\[", index);
      if (inlineCodeTicks === 0 && (escapedWiki || line.startsWith("[[", index))) {
        const delimiterLength = escapedWiki ? 4 : 2;
        const end = line.indexOf(escapedWiki ? "\\]\\]" : "]]", index + delimiterLength);
        if (end >= 0) {
          const value = line.slice(index + delimiterLength, end);
          const linked = line[index - 1] !== "!" ? obsidianWikiLink(value) : undefined;
          result += linked ?? `[[${value}]]`;
          index = end + delimiterLength;
          continue;
        }
      }
      if (inlineCodeTicks === 0 && (line.startsWith("\\(", index) || line.startsWith("\\[", index))) {
        mathEnd = line[index + 1] === "(" ? "\\)" : "\\]";
        result += line.slice(index, index + 2);
        index += 2;
        continue;
      }
      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return linkObsidianWikiLinks(turndown.turndown(preserveKatexSource(html))).trim();
}

export interface ChatGptMarkdownSegment {
  key: string;
  tag?: string;
  html: string;
  text: string;
  linkTargets?: string[];
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
  /** A reference preview may still replace its label, loading state or download link. */
  deferUntilComplete?: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  tag?: string;
  text: string;
  linkTargets?: string[];
  sourceStart?: number;
  sourceEnd?: number;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string, readonly diagnostic?: {
    reason: "text_changed" | "link_target_changed" | "block_order_changed" | "source_range_overlap";
    observedStart?: number;
    observedEnd?: number;
    committedStart?: number;
    committedEnd?: number;
    observedTextChars: number;
    committedTextChars: number;
    observedTag?: string;
    committedTag?: string;
    observedIndex: number;
    committedIndex: number;
  }) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. It can also virtualize an already-rendered prefix, so later DOM
 * snapshots are partial observations rather than the response ledger. The browser supplies source
 * ranges for semantic blocks and marks a block streamable only after a following block exists.
 * Once committed, a missing prefix is harmless; changing text at a committed source range remains
 * an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private consistencyError: ChatGptMarkdownConsistencyError | undefined;
  private deferUntilComplete = false;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
    private readonly delivery: "stream" | "complete" = "stream",
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    // Keep this sticky across preview removal and response-root remounts. Already delivered
    // text still goes through reconcile; only the remaining draft waits for finish().
    this.deferUntilComplete ||= segments.some(segment => segment.deferUntilComplete === true);
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      this.consistencyError = reconciled;
      return "";
    }
    this.consistencyError = undefined;
    this.latest = reconciled.map(segment => ({ ...segment }));
    // A compaction summary is delivered atomically. Until finish(), edits and reordering
    // revise an undelivered draft rather than contradicting text already sent to Codex.
    if (this.delivery === "complete" || this.deferUntilComplete) {
      this.candidates.clear();
      return "";
    }

    const visibleCandidates = new Set<string>();
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment);
      visibleCandidates.add(candidateId);
      const previous = this.candidates.get(candidateId);
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd;
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId);
    }

    let delta = "";
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!;
      const candidateId = this.candidateId(segment);
      const candidate = this.candidates.get(candidateId);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push(this.committedSegment(candidate));
      this.candidates.delete(candidateId);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError;
    let delta = "";
    for (const segment of this.latest) {
      delta += this.commit(segment);
      this.committed.push(this.committedSegment(segment));
    }
    this.candidates.clear();
    this.latest = [];
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined;
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    if (this.committed.length === 0 || segments.length === 0) return segments;

    const pending: ChatGptMarkdownSegment[] = [];
    const lastRangedCommitted = this.committed
      .filter(segment => segment.sourceEnd !== undefined)
      .at(-1);
    const lastCommittedEnd = lastRangedCommitted?.sourceEnd;
    let highestCommittedIndex = -1;
    const matchedCommitted = new Set<number>();
    let sawPending = false;
    let previousSourceStart: number | undefined;

    for (const [observedIndex, segment] of segments.entries()) {
      if (segment.sourceStart !== undefined) {
        if (previousSourceStart !== undefined && segment.sourceStart <= previousSourceStart) {
          return new ChatGptMarkdownConsistencyError(
            "ChatGPT final DOM exposed non-monotonic source ranges",
          );
        }
        previousSourceStart = segment.sourceStart;
      }
      const committedIndex = this.committedIndex(segment, highestCommittedIndex, matchedCommitted);
      if (committedIndex instanceof ChatGptMarkdownConsistencyError) return committedIndex;
      if (committedIndex !== undefined) {
        const committed = this.committed[committedIndex]!;
        if (sawPending || committedIndex <= highestCommittedIndex || committed.text !== segment.text) {
          return this.changedCommittedBlockError(
            sawPending || committedIndex <= highestCommittedIndex ? "block_order_changed" : "text_changed",
            segment,
            committed,
            observedIndex,
            committedIndex,
          );
        }
        highestCommittedIndex = committedIndex;
        matchedCommitted.add(committedIndex);
        // Link destinations are answer content even when textContent remains identical.
        // Cosmetic DOM/formatting hydration still does not invalidate a committed paragraph.
        if (JSON.stringify(committed.linkTargets ?? []) !== JSON.stringify(segment.linkTargets ?? [])) {
          return this.changedCommittedBlockError("link_target_changed", segment, committed, observedIndex, committedIndex);
        }
        continue;
      }

      if (segment.sourceStart !== undefined && lastCommittedEnd !== undefined) {
        if (segment.sourceStart <= lastCommittedEnd) {
          return this.changedCommittedBlockError(
            "source_range_overlap", segment, lastRangedCommitted!, observedIndex,
            this.committed.indexOf(lastRangedCommitted!),
          );
        }
        sawPending = true;
        pending.push(segment);
        continue;
      }

      const followsVisibleCommittedTail = highestCommittedIndex === this.committed.length - 1;
      // A known, undelivered paragraph also anchors new content after a virtualized
      // committed tail. Earlier committed blocks are still checked above for edits/reordering.
      if (!followsVisibleCommittedTail && !sawPending && !this.matchesLatestPending(segment)) {
        return new ChatGptMarkdownConsistencyError(
          "ChatGPT final DOM could not be aligned with text already streamed to Codex",
        );
      }
      sawPending = true;
      pending.push(segment);
    }

    return pending;
  }

  private committedIndex(
    segment: ChatGptMarkdownSegment,
    afterIndex: number,
    matched: ReadonlySet<number>,
  ): number | ChatGptMarkdownConsistencyError | undefined {
    const exact = this.committed.findIndex(committed => (
      segment.sourceStart !== undefined && committed.sourceStart !== undefined
        ? segment.sourceStart === committed.sourceStart && segment.tag === committed.tag
        : segment.key === committed.key
    ));
    if (exact >= 0) return exact;

    if (segment.sourceStart !== undefined) return undefined;
    if (!segment.tag) return undefined;
    // Empty text is not an identity: separate rules and images can share it.
    // Their exact DOM keys/ranges above remain valid, but a new empty block must
    // not be mistaken for an earlier committed one by the text-only match.
    if (!segment.text.trim()) return undefined;
    const semanticMatches = this.committed
      .map((committed, index) => ({ committed, index }))
      .filter(({ committed }) => committed.tag === segment.tag && committed.text === segment.text);
    // Match each committed occurrence at most once, in response order. A new
    // repeated paragraph must not be rebound to an occurrence already consumed
    // by this snapshot. Counting from zero breaks when earlier blocks disappear.
    const remaining = semanticMatches.filter(match => match.index > afterIndex);
    if (remaining.length === 1) return remaining[0]!.index;
    if (remaining.length > 1) {
      if (afterIndex >= 0 && remaining[0]!.index === afterIndex + 1) return remaining[0]!.index;
      return new ChatGptMarkdownConsistencyError("ChatGPT final DOM has ambiguous repeated text already streamed to Codex");
    }
    // A known pending tail can survive removal of its committed prefix. Without
    // that evidence, an unseen earlier occurrence is a reorder, not new text.
    const earlier = semanticMatches.find(match => !matched.has(match.index));
    if (earlier && !this.matchesLatestPending(segment)) return earlier.index;
    return undefined;
  }

  private matchesLatestPending(segment: ChatGptMarkdownSegment): boolean {
    const exact = this.latest.filter(candidate => (
      segment.sourceStart !== undefined && candidate.sourceStart !== undefined
        ? segment.sourceStart === candidate.sourceStart && segment.tag === candidate.tag
        : segment.key === candidate.key
    ));
    if (exact.length === 1) return true;
    if (segment.sourceStart !== undefined) return false;
    if (!segment.tag) return false;
    if (!segment.text.trim()) return false;
    return this.latest.filter(candidate => (
      candidate.tag === segment.tag && candidate.text === segment.text
    )).length === 1;
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `source:${segment.sourceStart}:${segment.tag ?? ""}`
      : `key:${segment.key}`;
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag ? { tag: segment.tag } : {}),
      text: segment.text,
      ...(segment.linkTargets ? { linkTargets: [...segment.linkTargets] } : {}),
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    };
  }

  private changedCommittedBlockError(
    reason: NonNullable<ChatGptMarkdownConsistencyError["diagnostic"]>["reason"],
    observed: ChatGptMarkdownSegment,
    committed: CommittedChatGptMarkdownSegment,
    observedIndex: number,
    committedIndex: number,
  ): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT changed a completed text block that was already streamed to Codex",
      {
        reason,
        observedStart: observed.sourceStart,
        observedEnd: observed.sourceEnd,
        committedStart: committed.sourceStart,
        committedEnd: committed.sourceEnd,
        observedTextChars: observed.text.length,
        committedTextChars: committed.text.length,
        observedTag: observed.tag,
        committedTag: committed.tag,
        observedIndex,
        committedIndex,
      },
    );
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
