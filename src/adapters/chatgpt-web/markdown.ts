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

/**
 * Buffers ChatGPT's mutable rendered answer until terminal DOM evidence is stable.
 *
 * The Web UI may rewrite an already-visible paragraph while hydrating citations, links, lists, or
 * a replacement renderer. Responses text deltas cannot be retracted, so no final-answer Markdown
 * is emitted before `finish`; live reasoning/status events remain a separate append-only stream.
 */
export class ChatGptMarkdownBuffer {
  private html = "";

  constructor(private readonly transform: (markdown: string) => string = markdown => markdown) {}

  observe(html: string): void {
    this.html = html;
  }

  finish(): { markdown: string; delta: string } {
    const markdown = this.transform(chatGptHtmlToMarkdown(this.html));
    return { markdown, delta: markdown };
  }
}
