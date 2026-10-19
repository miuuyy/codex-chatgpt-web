const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConversationRegistry, savedConversation } = require("../electron/conversation-registry.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

const first = "a".repeat(64);
const second = "b".repeat(64);
const account = "c".repeat(64);
const savedUrl = "https://chatgpt.com/c/00000000-0000-4000-8000-000000000001";

function withRegistry(action) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-saved-conversation-"));
  const file = path.join(directory, "conversation-registry.json");
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const result = action(file);
    if (result && typeof result.then === "function") return result.finally(cleanup);
    cleanup();
    return result;
  } catch (error) { cleanup(); throw error; }
}

test("conversation registry persists the exact account and conversation after restart", () => withRegistry(file => {
  const registry = new ConversationRegistry(file);
  assert.equal(registry.get(first), null);
  assert.equal(registry.arm(first, "initial_turn").status, "pending");
  assert.equal(new ConversationRegistry(file).get(first).status, "pending");
  assert.equal(registry.bind(first, savedUrl, account, "initial_turn").status, "bound");
  assert.deepEqual(new ConversationRegistry(file).get(first), registry.get(first));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(registry.bind(first, savedUrl, account).url, savedUrl);
  assert.throws(() => registry.bind(first, "https://chatgpt.com/c/different-chat", account), /conflicts/);
  assert.throws(() => registry.bind(first, savedUrl, second), /conflicts/);
  registry.arm(second, "second_turn");
  assert.throws(() => registry.bind(second, savedUrl, account), /another Codex session/);
}));

test("saved conversation URLs reject cross-origin, temporary, query and non-conversation URLs", () => {
  assert.deepEqual(savedConversation(`${savedUrl}#anchor`), { id: savedUrl.split("/").at(-1), url: savedUrl });
  for (const url of ["https://chatgpt.com/", "https://chatgpt.com/?temporary-chat=true",
    "https://evil.example/c/00000000-0000-4000-8000-000000000001",
    `${savedUrl}?secret=1`, "https://chatgpt.com/c/a", "https://chatgpt.com/c/%2Fetc%2Fpasswd"]) {
    assert.equal(savedConversation(url), null);
  }
});

test("pending sends block replay after a restart without a verified URL", async () => withRegistry(async file => {
  // A new launcher cannot distinguish a lost acceptance acknowledgement from no send.
  const registry = new ConversationRegistry(file);
  registry.arm(first, "initial_turn");
  const recovered = new ConversationRegistry(file);
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(), turnTabs: new Map(),
    conversationRegistry: recovered,
    getUseSavedChats: () => true,
    logger: { info() {} }, publishState() {}, snapshot: () => ({}),
    syncViewVisibility() {}, writeDescriptor() {},
    createTurnTab: async () => ({ id: "should-not-create", surfaceId: "should-not-create" }),
  });
  await assert.rejects(() => fixture.beginTurn("turn_next", false, 123, first, "Codex Native2"), /Recover the original chat/);
}));

test("a required retained turn can reopen the exact saved URL and isolates concurrent writers", async () => withRegistry(async file => {
  const registry = new ConversationRegistry(file);
  registry.arm(first, "initial_turn");
  registry.bind(first, savedUrl, account, "initial_turn");
  const tab = { id: "reopened", surfaceId: "x".repeat(32), traceId: "turn_next",
    helperPid: 123, status: "running", interactionMode: "automatic", conversationKey: first };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(), turnTabs: new Map(),
    conversationRegistry: new ConversationRegistry(file),
    getUseSavedChats: () => true,
    logger: { info() {} }, publishState() {}, snapshot: () => ({}),
    syncViewVisibility() {}, writeDescriptor() {},
    createTurnTab: async () => { fixture.turnTabs.set(tab.id, tab); return tab; },
  });
  const lease = await fixture.beginTurn("turn_next", false, 123, first, "Codex Native2", true);
  assert.equal(lease.reused, true);
  assert.equal(lease.recoveredUrl, savedUrl);
  assert.equal(lease.accountKey, account);
  await assert.rejects(() => fixture.beginTurn("concurrent", false, 321, first, "Codex Native2"), /still writing/);
  assert.equal(fixture.turnTabs.size, 1);
}));

test("an uncertain continuation blocks replay until the original send is reconciled", async () => withRegistry(async file => {
  const registry = new ConversationRegistry(file);
  registry.arm(first, "initial_turn");
  registry.bind(first, savedUrl, account, "initial_turn");
  registry.arm(first, "followup_turn");
  const recovered = new ConversationRegistry(file);
  assert.equal(recovered.get(first).pendingTraceId, "followup_turn");
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(), turnTabs: new Map(),
    conversationRegistry: recovered, logger: { info() {} }, publishState() {},
    getUseSavedChats: () => true,
    snapshot: () => ({}), syncViewVisibility() {}, writeDescriptor() {},
    createTurnTab: async () => { throw new Error("No new chat is permitted"); },
  });
  await assert.rejects(() => fixture.beginTurn("followup_turn", false, 1, first, "Codex Native2"), /without a confirmed receipt/);
  await assert.rejects(() => fixture.beginTurn("later_turn", false, 1, first, "Codex Native2"), /without a confirmed receipt/);
  recovered.submitted(first, "followup_turn");
  assert.equal(new ConversationRegistry(file).get(first).lastSubmittedTraceId, "followup_turn");
  await assert.rejects(() => fixture.beginTurn("followup_turn", false, 1, first, "Codex Native2"), /already submitted/);
  assert.throws(() => recovered.submitted(first, "followup_turn"), /without its reserved conversation/);
}));

test("an existing running browser owner cannot silently lease the same saved turn twice", async () => withRegistry(async file => {
  const registry = new ConversationRegistry(file);
  registry.arm(first, "initial_turn");
  registry.bind(first, savedUrl, account, "initial_turn");
  const existing = {
    id: "tab", traceId: "followup_turn", helperPid: 123,
    status: "running", interactionMode: "automatic", conversationKey: first,
    connectorIdentity: "Codex Native2",
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(),
    turnTabs: new Map([[existing.id, existing]]),
    conversationRegistry: registry, getUseSavedChats: () => true,
    logger: { info() {} }, publishState() {}, snapshot: () => ({}),
    syncViewVisibility() {}, writeDescriptor() {},
    createTurnTab: async () => { throw new Error("A duplicate must not allocate a browser"); },
  });
  await assert.rejects(() => fixture.beginTurn("followup_turn", false, 123, first, "Codex Native2"), /already owns/);
  assert.equal(fixture.turnTabs.size, 1);
}));

test("Temporary Chat mode does not look up or write saved conversation mappings", async () => withRegistry(async file => {
  const registry = new ConversationRegistry(file);
  registry.arm(first, "initial_turn");
  registry.bind(first, savedUrl, account, "initial_turn");
  const before = fs.readFileSync(file, "utf8");
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null, userCancelledTurnOwners: new Map(), turnTabs: new Map(),
    conversationRegistry: registry, getUseSavedChats: () => false,
    logger: { info() {} }, publishState() {}, snapshot: () => ({}),
    syncViewVisibility() {}, writeDescriptor() {},
    createTurnTab: async () => ({ id: "temporary-tab", surfaceId: "x".repeat(32) }),
  });
  const lease = await fixture.beginTurn("temporary_turn", false, 10, first, "Codex Native2");
  assert.equal(lease.reused, false);
  assert.equal(lease.recoveredUrl, undefined);
  assert.equal(fs.readFileSync(file, "utf8"), before);
}));
