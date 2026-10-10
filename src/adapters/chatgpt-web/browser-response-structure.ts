/** Runs in the page. Capture ownership/layout evidence without conversation text or attribute values. */
export function chatGptResponseStructures(roots: Element[]) {
  return roots.slice(-3).map(root => {
    const selected = root.querySelectorAll('.markdown, [data-markdown-text-style="assistant-message"], '
      + '[data-conversation-role], [data-message-author-role], [data-content-search-unit-key], '
      + '[data-streaming-response-status], [data-chatgpt-agent-turn-start], '
      + 'button[data-testid="copy-turn-action-button"], .turn-action-controls');
    const nodes = new Set<Element>([root]);
    let truncated = selected.length > 64;
    for (const candidate of [...selected].slice(0, 64)) {
      let node: Element | null = candidate;
      let depth = 0;
      for (; node && root.contains(node) && depth < 20; node = node.parentElement, depth++) {
        if (nodes.size >= 200 && !nodes.has(node)) { truncated = true; break; }
        nodes.add(node);
        if (node === root) break;
      }
      if (depth === 20) truncated = true;
    }
    const ordered = [...nodes].sort((a, b) => a === b ? 0
      : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const indices = new Map(ordered.map((node, index) => [node, index]));
    const tags = new Set(["div", "span", "article", "section", "p", "pre", "code", "button", "main"]);
    return {
      truncated,
      nodes: ordered.map(node => {
        const tag = node.tagName.toLowerCase();
        let rendered = node.isConnected;
        for (let parent: Element | null = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (parent.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden"
            || style.opacity === "0") { rendered = false; break; }
        }
        return {
          parent: indices.get(node.parentElement!) ?? -1,
          tag: tags.has(tag) ? tag : "other",
          rendered,
          assistant: node.getAttribute("data-conversation-role") === "assistant"
            || node.getAttribute("data-message-author-role") === "assistant"
            || node.getAttribute("data-turn") === "assistant",
          user: node.getAttribute("data-conversation-role") === "user"
            || node.getAttribute("data-message-author-role") === "user"
            || node.getAttribute("data-turn") === "user",
          searchUnit: node.hasAttribute("data-content-search-unit-key"),
          markdown: node.matches('.markdown, [data-markdown-text-style="assistant-message"]'),
          streamingStatus: node.hasAttribute("data-streaming-response-status"),
          activityStart: node.hasAttribute("data-chatgpt-agent-turn-start"),
          completionControl: node.matches('button[data-testid="copy-turn-action-button"], .turn-action-controls'),
        };
      }),
    };
  });
}
