import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown))
      .toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});

test("converts each KaTeX formula to one LaTeX source", () => {
  const markdown = chatGptHtmlToMarkdown(
    readFileSync(join(import.meta.dir, "fixtures/chatgpt-katex-answer.html"), "utf8"),
  );

  // U+2061 occurs only in the MathML layer and U+200B only in the visual katex-html layer.
  expect(markdown).not.toMatch(/[\u2061\u200b]/);
  expect(markdown).toBe([
    String.raw`Inline: \(E = mc^2\) and \(\operatorname{softmax}(z)_i = \frac{e^{z_i}}{\sum_j e^{z_j}}\) beside a [link](https://example.com/notes) and literal a\_b.`,
    "",
    "\\[",
    String.raw`r_{\mathrm{eff}} = \exp\left(-\sum_i q_i \log q_i\right)`,
    "\\]",
    "",
    String.raw`- Item with \(\alpha + \beta\)`,
    "- Display in a list:",
    "  ",
    "  \\[",
    String.raw`  \int_0^1 x^2 \,dx = \tfrac{1}{3}`,
    "  \\]",
    "",
    // LaTeX is never read as an Obsidian link, while the prose link beside it still is.
    "Unicode input \\(α ≤ β\\) and an Iverson bracket \\([[P]] = 1\\) next to [Notes](<Notes.md>).",
    "",
    // Without the browser projection, Turndown has already collapsed the annotation to one line.
    "> Quoted derivation:",
    "> ",
    "> \\[",
    String.raw`> \begin{aligned} a &= b + c \\ &= d \end{aligned}`,
    "> \\]",
    "",
    "```latex",
    "\\[ E = mc^2 \\]",
    "```",
  ].join("\n"));
});

test("formula placeholders cannot collide with answer text", () => {
  const answer = readFileSync(join(import.meta.dir, "fixtures/chatgpt-katex-answer.html"), "utf8");
  // HTML parsing drops a raw U+0000 and decodes &#0; to U+FFFD, so neither can name a formula.
  expect(chatGptHtmlToMarkdown(`<p>Literal \0${"0"}\0 and &#0;1&#0;</p>${answer}`))
    .toBe(`Literal 0 and �1�\n\n${chatGptHtmlToMarkdown(answer)}`);
});
