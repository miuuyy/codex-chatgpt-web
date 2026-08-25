import { expect, test } from "bun:test";
import {
  assertAuthenticatedChatGptPage,
  CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  detectChatGptAccountCapabilities,
  resolveChatGptEffortMenu,
} from "../src/chatgpt-session";

test("login keeps the established turn composer contract", () => {
  const turnSelectors = CHATGPT_COMPOSER_SELECTOR.split(",").map(selector => selector.trim());
  expect(turnSelectors).toContain('[data-testid="prompt-textarea"]');
  expect(turnSelectors).toContain("#prompt-textarea");
  expect(turnSelectors).toContain('[contenteditable="true"][data-lexical-editor="true"]');
  expect(turnSelectors).not.toContain('form [contenteditable="true"]');
  expect(turnSelectors).not.toContain("form textarea[placeholder]");
});

type FakeNode = {
  id?: string;
  visible?: boolean;
  semanticCount?: number;
  attributes?: Record<string, string | null>;
};

function fakeLocator(nodes: FakeNode[]): any {
  return {
    filter: () => fakeLocator(nodes.filter(node => node.visible !== false)),
    count: async () => nodes.length,
    first: () => fakeLocator(nodes.slice(0, 1)),
    getAttribute: async (name: string) => name === "id"
      ? nodes[0]?.id ?? null
      : nodes[0]?.attributes?.[name] ?? null,
    locator: () => fakeLocator(Array.from(
      { length: nodes[0]?.semanticCount ?? 0 },
      () => ({ visible: true }),
    )),
  };
}

function effortMenuPage(entries: Record<string, FakeNode[]>): { page: any; selectors: string[] } {
  const selectors: string[] = [];
  return {
    selectors,
    page: {
      locator(selector: string) {
        selectors.push(selector);
        return fakeLocator(entries[selector] ?? []);
      },
    },
  };
}

test("the effort selector identifies the model slider instead of any composer menu button", () => {
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-animated-slider-trigger="true"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-testid="model-switcher-dropdown-button"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).not.toBe('button[aria-haspopup="menu"]');
});

test("current picker testid is resolved without consulting an unrelated global menu", async () => {
  const target = { id: "current-picker", visible: true, semanticCount: 5 };
  const unrelated = { id: "unrelated-menu", visible: true, semanticCount: 3 };
  const { page, selectors } = effortMenuPage({
    [CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR]: [target],
    '[role="menu"]': [unrelated],
  });
  const control = fakeLocator([{ attributes: {} }]);

  const resolved = await resolveChatGptEffortMenu(page, control);
  expect(await resolved?.getAttribute("id")).toBe("current-picker");
  expect(selectors).toEqual([CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR]);
});

test("legacy picker is accepted only through the effort control ownership relation", async () => {
  const legacy = { id: "legacy-effort", visible: true, semanticCount: 3 };
  const { page, selectors } = effortMenuPage({
    '[id="legacy-effort"]': [legacy],
  });
  const control = fakeLocator([{ attributes: { "aria-controls": "legacy-effort" } }]);

  const resolved = await resolveChatGptEffortMenu(page, control);
  expect(await resolved?.getAttribute("id")).toBe("legacy-effort");
  expect(selectors).toEqual(['[id="legacy-effort"]']);
});

test("unowned legacy and unrelated menus are ignored", async () => {
  const unrelated = { id: "unrelated", visible: true, semanticCount: 3 };
  const { page, selectors } = effortMenuPage({
    '[role="menu"]': [unrelated],
  });
  const control = fakeLocator([{ attributes: {} }]);

  expect(await resolveChatGptEffortMenu(page, control)).toBeUndefined();
  expect(selectors).toEqual([CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR]);
});

test("multiple canonical or owned effort menus fail closed", async () => {
  const duplicatePage = effortMenuPage({
    [CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR]: [
      { visible: true, semanticCount: 3 },
      { visible: true, semanticCount: 3 },
    ],
  }).page;
  await expect(resolveChatGptEffortMenu(duplicatePage, fakeLocator([{ attributes: {} }])))
    .rejects.toThrow("ambiguous");

  const ownedPage = effortMenuPage({}).page;
  await expect(resolveChatGptEffortMenu(ownedPage, fakeLocator([{
    attributes: { "aria-controls": "first second" },
  }]))) .rejects.toThrow("owns multiple");
});

test("an owned node is not a picker until effort semantics hydrate", async () => {
  const { page } = effortMenuPage({
    '[id="hydrating-picker"]': [{ visible: true, semanticCount: 0 }],
  });
  const control = fakeLocator([{ attributes: { "aria-owns": "hydrating-picker" } }]);
  expect(await resolveChatGptEffortMenu(page, control)).toBeUndefined();
});

test("authentication requires both the current composer and an authenticated account control", async () => {
  expect(CHATGPT_COMPOSER_SELECTOR.split(", ")).toContain("#prompt-textarea");
  expect(CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR.split(", "))
    .toContain('[data-testid="accounts-profile-button"][role="button"]');
  expect(CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR)
    .not.toContain('button[data-testid="accounts-profile-button"]');

  const observedSelectors: string[] = [];
  const visiblePage = {
    locator(selector: string) {
      observedSelectors.push(selector);
      return {
        count: async () => selector === CHATGPT_COMPOSER_SELECTOR
          || selector === CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR ? 1 : 0,
        nth: () => ({ isVisible: async () => true }),
      };
    },
  };
  await expect(assertAuthenticatedChatGptPage(visiblePage as never)).resolves.toBeUndefined();
  expect(observedSelectors).toEqual([
    CHATGPT_COMPOSER_SELECTOR,
    CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR,
  ]);

  const hiddenPage = {
    locator: () => ({
      count: async () => 1,
      nth: () => ({ isVisible: async () => false }),
    }),
  };
  await expect(assertAuthenticatedChatGptPage(hiddenPage as never))
    .rejects.toThrow("no visible composer is present");

  const missingPage = {
    locator: () => ({
      count: async () => 0,
      nth: () => ({ isVisible: async () => false }),
    }),
  };
  await expect(assertAuthenticatedChatGptPage(missingPage as never))
    .rejects.toThrow("no visible composer is present");

  const guestPage = {
    locator: (selector: string) => ({
      count: async () => selector === CHATGPT_COMPOSER_SELECTOR ? 1 : 0,
      nth: () => ({ isVisible: async () => true }),
    }),
  };
  await expect(assertAuthenticatedChatGptPage(guestPage as never))
    .rejects.toThrow("no authenticated account control is present");
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    filter() { return this; },
    first() { return this; },
    last() { return this; },
    count: async () => 0,
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    first() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    filter() { return this; },
    first() { return this; },
    last() { return this; },
    count: async () => {
      visibilityReads += 1;
      return visibilityReads === 1 ? 1 : 0;
    },
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    first() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});
