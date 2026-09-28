const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const KEY = /^[a-f0-9]{64}$/;
const CONVERSATION_ID = /^[a-zA-Z0-9_-]{8,128}$/;

function savedConversation(url) {
  try {
    const parsed = new URL(url);
    const match = /^\/c\/([a-zA-Z0-9_-]{8,128})\/?$/.exec(parsed.pathname);
    if (parsed.origin !== "https://chatgpt.com" || !match || parsed.username || parsed.password
      || parsed.search || !CONVERSATION_ID.test(match[1])) return null;
    return { id: match[1], url: `https://chatgpt.com/c/${match[1]}` };
  } catch { return null; }
}

class ConversationRegistry {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = {};
    if (!filePath || !fs.existsSync(filePath)) return;
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (state?.version !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)) {
      throw new Error("ChatGPT conversation registry has an unsupported format");
    }
    for (const [key, value] of Object.entries(state.entries)) {
      if (!KEY.test(key) || !value || !["pending", "bound"].includes(value.status)
        || (value.accountKey !== undefined && !KEY.test(value.accountKey))
        || (value.pendingTraceId !== undefined && (typeof value.pendingTraceId !== "string" || value.pendingTraceId.length > 128))
        || (value.lastSubmittedTraceId !== undefined && (typeof value.lastSubmittedTraceId !== "string" || value.lastSubmittedTraceId.length > 128))
        || (value.status === "bound" && (!KEY.test(value.accountKey)
          || savedConversation(value.url)?.id !== value.id))) {
        throw new Error("ChatGPT conversation registry is corrupt; preserve it for manual recovery");
      }
    }
    this.entries = state.entries;
  }

  get(key) {
    if (!KEY.test(key)) throw new Error("Invalid Codex conversation identity");
    return this.entries[key] ? { ...this.entries[key] } : null;
  }

  write(key, entry) {
    const next = { ...this.entries, [key]: { ...entry, updatedAt: new Date().toISOString() } };
    writePrivateFileAtomic(this.filePath, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`);
    this.entries = next;
    return this.get(key);
  }

  arm(key, traceId) {
    if (typeof traceId !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("Invalid Codex turn identity for saved conversation");
    }
    const current = this.get(key);
    if (current?.pendingTraceId && current.pendingTraceId !== traceId) {
      throw new Error("An earlier ChatGPT send has not been reconciled");
    }
    if (current?.status === "bound") {
      return this.write(key, { ...current, pendingTraceId: traceId });
    }
    if (current) return current;
    // Persist the ambiguity boundary before Enter can physically submit a new message.
    return this.write(key, { status: "pending", pendingTraceId: traceId });
  }

  bind(key, url, accountKey, traceId) {
    const conversation = savedConversation(url);
    if (!conversation || !KEY.test(accountKey)) {
      throw new Error("ChatGPT saved conversation or authenticated account could not be verified");
    }
    const current = this.get(key);
    if (!current) throw new Error("ChatGPT conversation was not reserved before submission");
    if (traceId && current.pendingTraceId !== traceId) {
      throw new Error("ChatGPT conversation submission receipt does not match the reserved turn");
    }
    if (current.status === "bound" && (current.id !== conversation.id || current.accountKey !== accountKey)) {
      throw new Error("ChatGPT conversation mapping conflicts with the saved conversation");
    }
    for (const [owner, entry] of Object.entries(this.entries)) {
      if (owner !== key && entry.status === "bound" && entry.id === conversation.id && entry.accountKey === accountKey) {
        throw new Error("ChatGPT conversation already belongs to another Codex session");
      }
    }
    return this.write(key, { status: "bound", id: conversation.id, url: conversation.url, accountKey,
      ...(traceId ? { lastSubmittedTraceId: traceId } : {}),
      ...(!traceId && current.lastSubmittedTraceId ? { lastSubmittedTraceId: current.lastSubmittedTraceId } : {}),
    });
  }

  submitted(key, traceId) {
    const current = this.get(key);
    if (!current || current.status !== "bound" || current.pendingTraceId !== traceId) {
      throw new Error("ChatGPT submission cannot be acknowledged without its reserved conversation");
    }
    const { pendingTraceId, ...bound } = current;
    return this.write(key, { ...bound, lastSubmittedTraceId: traceId });
  }
}

module.exports = { ConversationRegistry, savedConversation };
