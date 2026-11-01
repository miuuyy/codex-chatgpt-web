import { expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";

test("plain checker JSON reaches strict consumers without Markdown escapes", () => {
  const json = '{"overrides":[],"artifacts":[]}';
  const markdown = chatGptHtmlToMarkdown(`<p>${json}</p>`);
  expect(markdown).toBe(json);
  expect(JSON.parse(markdown)).toEqual({ overrides: [], artifacts: [] });
});

test("observed paragraph presentation preserves fragmented checker JSON for strict consumers", () => {
  const json = '{"overrides":[{"field":"humanFinal","language":"en","excerpt":"이번 최종 답변은 영어로 작성하라.","persistent":false}],"artifacts":[]}';
  const html = '<p class="Paragraph-kKnbIo" dir="auto"><span>{"overrides"</span>'
    + ':[{"field":"humanFinal","language":"en","excerpt":"이번 최종 답변은 영어로 작성하라.","persistent":false}]'
    + '<span>,"artifacts"</span>:[]<span>}</span></p>';
  const markdown = chatGptHtmlToMarkdown(html);
  expect(markdown).toBe(json);
  expect(JSON.parse(markdown)).toEqual({
    overrides: [{ field: "humanFinal", language: "en", excerpt: "이번 최종 답변은 영어로 작성하라.", persistent: false }],
    artifacts: [],
  });
});

test("plain JSON admits only narrow paragraph classes and direction values", () => {
  const json = '{"items":[]}';
  for (const dir of ["auto", "ltr", "rtl"]) {
    expect(chatGptHtmlToMarkdown(`<p class="Paragraph-aZ09_-" dir="${dir}">${json}</p>`)).toBe(json);
  }
  expect(chatGptHtmlToMarkdown(`<div dir="ltr"><span dir="rtl">${json}</span></div>`)).toBe(json);
  for (const attributes of [
    'class="Paragraph-kKnbIo sr-only"', 'class="Paragraph-"', 'class="Paragraph-a.b"',
    'class="plain"', 'dir="invalid"', 'class="Paragraph-kKnbIo" style="display:none"',
    'class="Paragraph-kKnbIo" hidden', 'class="Paragraph-kKnbIo" role="status"',
  ]) {
    expect(chatGptHtmlToMarkdown(`<p ${attributes}>${json}</p>`)).toBe('{"items":\\[\\]}');
  }
  expect(chatGptHtmlToMarkdown(`<span class="Paragraph-kKnbIo">${json}</span>`)).toBe('{"items":\\[\\]}');
});

test("plain JSON preserves nested data and original lexical spelling", () => {
  const json = String.raw`[{"nested":{"items":["*_text_*","[[Notes/item|label]]","a & b < c","quote: \" slash: \\ newline: \n unicode: \u0041"]},"n":1.2300e+02,"zero":-0,"same":1,"same":2}]`;
  const html = json.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const markdown = chatGptHtmlToMarkdown(`<div><span>${html}</span></div>`);
  expect(markdown).toBe(json);
  expect(JSON.parse(markdown)[0].nested.items[1]).toBe("[[Notes/item|label]]");
});

test("plain JSON retains line breaks from layout and source-offset wrappers", () => {
  const html = '<div data-start="0" data-end="80"><p>{</p>'
    + '<div data-start="2" data-end="70"><span data-is-last-node="true">  "items": [</span><br>'
    + '<span>    1,</span><br><span>    2</span><br><span>  ]</span></div>'
    + '<!-- source boundary --><p>}</p></div>';
  const markdown = chatGptHtmlToMarkdown(html);
  expect(JSON.parse(markdown)).toEqual({ items: [1, 2] });
  for (const separator of ["<br>", "</div><div>"]) {
    const splitNumber = `<div>{"items":[1${separator}2]}</div>`;
    expect(() => JSON.parse(chatGptHtmlToMarkdown(splitNumber))).toThrow();
  }
});

test("prose, malformed JSON, and Markdown structures retain normal conversion", () => {
  expect(chatGptHtmlToMarkdown('<p>Result {"items":[]} [[Notes/result]]</p>'))
    .toBe('Result {"items":\\[\\]} [Notes/result](<Notes/result.md>)');
  for (const text of ['{"items":[]', '{"items":[],}', '[1] trailing', '{} {}']) {
    expect(() => JSON.parse(chatGptHtmlToMarkdown(`<p>${text}</p>`))).toThrow();
  }
  expect(chatGptHtmlToMarkdown('<pre><code>{"items":[]}</code></pre>'))
    .toBe('```\n{"items":[]}\n```');
  expect(chatGptHtmlToMarkdown('<p><code>{"items":[]}</code></p>'))
    .toBe('`{"items":[]}`');
  expect(chatGptHtmlToMarkdown('<p><a href="https://example.com">{"items":[]}</a></p>'))
    .toBe('[{"items":\\[\\]}](https://example.com)');
  expect(chatGptHtmlToMarkdown(`<p>${katex('{"items":[]}')}</p>`))
    .toBe('\\({"items":[]}\\)');
});

test("semantic tags and non-source attributes cannot admit JSON as plain layout", () => {
  const json = '{"items":[]}';
  for (const tag of ["strong", "em", "section", "article", "aside", "button", "script", "style"]) {
    expect(() => JSON.parse(chatGptHtmlToMarkdown(`<${tag}>${json}</${tag}>`))).toThrow();
  }
  for (const attribute of [
    'class="plain"', 'style="display:none"', 'role="status"', "hidden", "inert",
    'contenteditable="false"', 'data-code-block-preview-pane="json"', 'data-state="closed"',
  ]) {
    expect(chatGptHtmlToMarkdown(`<span ${attribute}>${json}</span>`)).toBe('{"items":\\[\\]}');
  }
});

test("buffer commits plain JSON once and still rejects a committed JSON rewrite", () => {
  const json = '{"overrides":[],"artifacts":[]}';
  const segment = (text: string) => ({
    key: "checker", tag: "p", html: `<p data-start="0" data-end="80">${text}</p>`,
    text, sourceStart: 0, sourceEnd: 80, streamable: true,
  });
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe([segment(json)], 0)).toBe(json);
  expect(buffer.observe([segment(json)], 1)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: json, delta: "" });
  buffer.observe([segment('{"overrides":["changed"],"artifacts":[]}')], 2);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("atomic summaries accept a revised draft while ordinary streamed answers still reject changes", () => {
  const first = { key: "a", tag: "p", html: "<p>Earlier summary.</p>", text: "Earlier summary.", streamable: true };
  const second = { key: "b", tag: "p", html: "<p>Final detail.</p>", text: "Final detail.", streamable: true };
  const revised = { ...first, html: "<p>Corrected summary.</p>", text: "Corrected summary." };
  const summary = new ChatGptMarkdownBuffer(undefined, 0, "complete");
  const answer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const draft of [[first, second], [first, second], [second, revised]]) {
    expect(summary.observe(draft)).toBe("");
    answer.observe(draft);
  }
  expect(summary.finish()).toEqual({
    markdown: "Final detail.\n\nCorrected summary.", delta: "Final detail.\n\nCorrected summary.",
  });
  expect(() => answer.finish()).toThrow("completed text block");
});

function katex(source: string, display = false): string {
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const math = '<span class="katex"><span class="katex-mathml"><math><semantics>'
    + '<mrow><mi>ACCESSIBLE_COPY</mi><mo>\u2061</mo></mrow>'
    + `<annotation encoding="application/x-tex">${escaped}</annotation>`
    + '</semantics></math></span><span class="katex-html" aria-hidden="true">VISUAL_COPY\u200b</span></span>';
  return display ? `<span class="katex-display">${math}</span>` : math;
}

test("KaTeX inline and display formulas preserve exactly one original LaTeX expression", () => {
  const inline = String.raw`E = mc^2`;
  const display = String.raw`r_{\mathrm{eff}} = \exp\left(-\sum_i q_i \log q_i\right)`;
  expect(chatGptHtmlToMarkdown(`<p>Inline: ${katex(inline)}.</p>${katex(display, true)}`)).toBe(
    `Inline: \\(${inline}\\).\n\n\\[\n${display}\n\\]`,
  );
});

test("math source survives lists, links, nested braces, Unicode, and wiki-shaped expressions", () => {
  const source = String.raw`\operatorname{rank}\left(\frac{α_{i}}{1+β}\right) < 2 \quad [[x]]`;
  expect(chatGptHtmlToMarkdown(
    `<ul><li>Value ${katex(source)}; <a href="https://example.com">reference</a>.</li></ul>`
      + '<p>Open [[Notes/math|notes]].</p>' + katex(`${source}\n+ γ`, true),
  )).toBe(`- Value \\(${source}\\); [reference](https://example.com).\n\n`
    + `Open [notes](<Notes/math.md>).\n\n\\[\n${source}\n+ γ\n\\]`);
  const code = String.raw`\frac{a_b}{c} [[literal]]`;
  expect(chatGptHtmlToMarkdown(`<p><code>${code}</code></p><pre><code>${code}</code></pre>`))
    .toBe(`\`${code}\`\n\n\`\`\`\n${code}\n\`\`\``);
});

test("LaTeX comment newlines survive generic HTML whitespace normalization", () => {
  const source = "a % comment\n+ b";
  expect(chatGptHtmlToMarkdown(katex(source, true))).toBe(`\\[\n${source}\n\\]`);
});

test("unknown or ambiguous KaTeX source fails instead of inventing a formula", () => {
  const formula = katex("x");
  expect(() => chatGptHtmlToMarkdown(formula.replace(/<annotation[^>]*>.*?<\/annotation>/, "")))
    .toThrow("one unambiguous LaTeX source");
  expect(() => chatGptHtmlToMarkdown(formula.replace("</semantics>",
    '<annotation encoding="application/x-tex">y</annotation></semantics>')))
    .toThrow("one unambiguous LaTeX source");
});

test("streaming formulas once still rejects a rewrite of committed math", () => {
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  const segment = (source: string) => ({
    key: "formula", tag: "p", text: `ACCESSIBLE_COPY${source}VISUAL_COPY`,
    html: `<p>${katex(source)}</p>`, streamable: true,
  });
  expect(buffer.observe([segment("x_1")], 0)).toBe(String.raw`\(x_1\)`);
  expect(buffer.observe([segment("x_1")], 1)).toBe("");
  buffer.observe([segment("x_2")], 2);
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

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


test("repeated report headings can first appear after an earlier copy was committed", () => {
  for (const { count, repeated, tag, text } of [
    { count: 93, repeated: [15, 20, 25, 29], tag: "p", text: "変更済み:" },
    { count: 199, repeated: [40, 83], tag: "h2", text: "Functions" },
  ]) {
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    const report = Array.from({ length: count }, (_, index) => {
      const blockTag = repeated.includes(index) ? tag : "p";
      const value = repeated.includes(index) ? text : `Unique block ${index}`;
      return { key: `${index}:${blockTag}`, tag: blockTag, text: value,
        html: `<${blockTag}>${value}</${blockTag}>`, streamable: true };
    });
    for (let length = 2; length <= report.length; length += 1) {
      buffer.observe(report.slice(0, length).map((block, index) => ({
        ...block, streamable: index < length - 1,
      })), length);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
    }
    const expected = report.map(block => chatGptHtmlToMarkdown(block.html)).join("\n\n");
    expect(buffer.finish().markdown).toBe(expected);
    buffer.observe([report[0]!, report[0]!], count + 1);
    expect(() => buffer.finish()).toThrow("changed a completed text block");
  }
});
