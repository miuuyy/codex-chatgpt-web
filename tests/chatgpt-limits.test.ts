import { expect, test } from "bun:test";
import {
  chatGptLimitsPlanFromHeadings,
  chatGptUsageModelFromAnnouncements,
  detectChatGptLimitsPlan,
  readChatGptUsageAccount,
} from "../src/adapters/chatgpt-web/limits";

test("Limits requires an unambiguous current Pro tier instead of a badge or advertised price", () => {
  expect(chatGptLimitsPlanFromHeadings(["Billing", "ChatGPT Pro 20x", "Transaction history"])).toBe("pro_200");
  expect(chatGptLimitsPlanFromHeadings(["ChatGPT Pro 5x"])).toBe("pro_100");
  for (const headings of [["Pro"], ["$200"], ["ChatGPT Plus"], ["ChatGPT Pro"],
    ["ChatGPT Pro 5x", "ChatGPT Pro 20x"], ["Upgrade to ChatGPT Pro 20x"]]) {
    expect(() => chatGptLimitsPlanFromHeadings(headings)).toThrow("Could not distinguish");
  }
});

test("Limits identifies actual selected Pro family and keeps missing or conflicting evidence unknown", () => {
  expect(chatGptUsageModelFromAnnouncements(["6 Pro, 5 of 5.", "Use Left and Right arrow keys to adjust power."])).toBe("gpt-6-pro");
  expect(chatGptUsageModelFromAnnouncements(["5.6 Pro, 5 of 5."])).toBe("gpt-5.6-pro");
  expect(chatGptUsageModelFromAnnouncements(["GPT-5.6 Sol Pro, 5 of 5."])).toBe("gpt-5.6-pro");
  for (const descriptions of [[], ["Latest"], ["Pro"], ["5.6 Extra High, 4 of 5."],
    ["5.5 Pro"], ["6 Pro", "5.6 Pro"], ["Use 6 Pro"]]) {
    expect(chatGptUsageModelFromAnnouncements(descriptions)).toBe("pro-unknown");
  }
});

test("Limits exposes only hashed account identity and distinguishes personal and workspace accounts", async () => {
  let accountId = "account-personal";
  let structure = "personal";
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: async () => ({ userId: "user-id", accountId, structure, planType: "pro", needsAttention: false }),
  };
  const personal = await readChatGptUsageAccount(page as never);
  expect(personal.accountKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(personal)).not.toContain("user-id");
  expect(JSON.stringify(personal)).not.toContain(accountId);
  accountId = "account-business";
  structure = "workspace";
  const workspace = await readChatGptUsageAccount(page as never);
  expect(workspace.personal).toBe(false);
  expect(workspace.accountKey).not.toBe(personal.accountKey);
});

test("unsupported plans and payment problems never activate browser plan inspection", async () => {
  let planType = "plus";
  let needsAttention = false;
  const page = {
    url: () => "https://chatgpt.com/",
    evaluate: async () => ({ userId: "u", accountId: "a", planType, structure: "personal", needsAttention }),
    getByRole: () => { throw new Error("Must not touch the browser for this account"); },
  };
  expect((await detectChatGptLimitsPlan(page as never)).plan).toBe("unsupported");
  planType = "pro";
  needsAttention = true;
  await expect(detectChatGptLimitsPlan(page as never)).rejects.toThrow("subscription payment problem");
});

function planInspectionFixture(modern: boolean, plan: string, options: { duplicate?: boolean; switchAccount?: boolean } = {}) {
  const { createDocument } = require("@mixmark-io/domino");
  const row = `<div class="@container/settings-row"><div>${plan}</div><button>Alterar plano</button></div>`;
  const document = createDocument(`<main>${row}${options.duplicate ? row : ''}
    <table><tr><td>ChatGPT Pro 5x</td></tr><tr><td>ChatGPT Pro 20x</td></tr></table>
    <div class="@container/settings-row"><div>ChatGPT Pro 5x</div><button>Upgrade</button></div>
  </main>`);
  const original = 'https://chatgpt.com/?temporary-chat=true';
  let url = original;
  let reads = 0;
  const actions: string[] = [];
  const profile: any = {
    or: () => profile,
    and: (ready: { selector: string }) => { expect(ready.selector).toBe(':not([aria-busy="true"])'); return profile; },
    filter: () => profile,
    press: async (key: string) => { expect(key).toBe('Enter'); actions.push('profile'); },
  };
  const item: any = {
    or: () => item, filter: () => item, isVisible: async () => false,
    click: async () => { actions.push('settings'); if (modern) url = 'https://chatgpt.com/settings/general-settings'; },
  };
  const billing: any = {
    filter: () => billing,
    click: async () => { actions.push('billing'); if (modern) url = 'https://chatgpt.com/settings/billing'; },
  };
  const settings: any = {
    filter: () => settings, count: async () => 0, isVisible: async () => !modern,
    or: () => ({ first: () => ({ waitFor: async () => {} }) }),
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe('hidden'); },
    locator: (selector: string) => selector.includes('trigger-Billing') ? billing : {
      getByRole: () => ({ waitFor: async () => {}, allTextContents: async () => [plan] }),
    },
  };
  const page = {
    url: () => url,
    evaluate: async () => ({ userId: 'u', accountId: options.switchAccount && ++reads > 1 ? 'other' : 'a', planType: 'pro', structure: 'personal', needsAttention: false }),
    getByTestId: (id: string) => id === 'accounts-profile-button' ? profile : item,
    getByRole: (role: string, query?: { name?: string }) => role === 'dialog' ? settings : { name: query?.name },
    locator: (selector: string): any => {
      if (selector === ':not([aria-busy="true"])') return { selector };
      if (selector.includes('trigger-Billing')) return billing;
      if (selector === 'button[data-settings-panel-slug="billing"]') return billing;
      return { filter: ({ has }: { has: { name: string } }) => {
        const rows = Array.from(document.querySelectorAll(selector) as NodeListOf<Element>)
          .filter(e => Array.from(e.querySelectorAll('button')).some(b => b.textContent === has.name));
        return {
          waitFor: async () => { if (rows.length !== 1) throw new Error('Ambiguous current subscription'); },
          getByText: (name: RegExp) => ({ allTextContents: async () => rows.flatMap(row =>
            Array.from(row.querySelectorAll('*')).filter(e => e.children.length === 0 && name.test(e.textContent ?? '')).map(e => e.textContent!),
          ) }),
        };
      } };
    },
    waitForURL: async (match: (url: URL) => boolean) => { expect(match(new URL(url))).toBe(true); },
    goto: async (target: string) => { expect(target).toBe(original); url = target; actions.push('return'); },
    keyboard: { press: async (key: string) => { expect(key).toBe('Escape'); actions.push('dismiss'); } },
  };
  return { page, actions, original };
}

test.each([false, true])("Limits checks the current subscription and restores its UI (modern=%s)", async modern => {
  for (const [label, expected] of [['ChatGPT Pro 5x', 'pro_100'], ['ChatGPT Pro 20x', 'pro_200']] as const) {
    const { page, actions, original } = planInspectionFixture(modern, label!);
    expect((await detectChatGptLimitsPlan(page as never)).plan).toBe(expected);
    expect(actions).toEqual(['profile', 'settings', 'billing', modern ? 'return' : 'dismiss']);
    expect(page.url()).toBe(original);
  }
});

test.each(['unknown', 'duplicate', 'account-change'])("Limits rejects %s evidence and restores the chat", async failure => {
  const { page, actions, original } = planInspectionFixture(true, failure === 'unknown' ? 'ChatGPT Pro' : 'ChatGPT Pro 20x', {
    duplicate: failure === 'duplicate', switchAccount: failure === 'account-change',
  });
  await expect(detectChatGptLimitsPlan(page as never)).rejects.toThrow();
  expect(actions.at(-1)).toBe('return');
  expect(page.url()).toBe(original);
});
