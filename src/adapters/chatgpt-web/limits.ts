import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright-core";

export type ChatGptLimitsPlan = "pro_100" | "pro_200" | "unsupported";
export type ChatGptUsageModel = "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

/** Session eligibility only; the current Billing heading determines the allowance. */
export function supportsChatGptUsageTracking(account: { personal: boolean; planType: string }): boolean {
  return account.personal && ["pro", "prolite"].includes(account.planType);
}

/** Only stable account identity leaves the page; never export session credentials. */
export async function readChatGptUsageAccount(page: Page): Promise<{
  accountKey: string;
  planType: string;
  personal: boolean;
  needsAttention: boolean;
}> {
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new Error("Open ChatGPT and sign in before setting up Limits.");
  }
  const identity = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
    const url = new URL(response.url);
    if (!response.ok || url.origin !== "https://chatgpt.com" || url.pathname !== "/api/auth/session") {
      throw new Error("Limits could not verify the current ChatGPT account.");
    }
    const session = await response.json();
    // Deliberately copy only these fields from the session response.
    return {
      userId: session?.user?.id,
      accountId: session?.account?.id,
      planType: session?.account?.planType,
      structure: session?.account?.structure,
      needsAttention: session?.account?.isDelinquent === true,
    };
  });
  if ([identity.userId, identity.accountId, identity.planType, identity.structure]
    .some(value => typeof value !== "string" || !value || value.length > 256)) {
    throw new Error("Limits could not identify the current ChatGPT account. Sign in and retry.");
  }
  return {
    accountKey: createHash("sha256").update(`${identity.userId}\0${identity.accountId}`).digest("hex"),
    planType: identity.planType,
    personal: identity.structure === "personal",
    needsAttention: identity.needsAttention,
  };
}

/** Read the current subscription heading, not upgrade offers, invoices, or a bare 'Pro' badge. */
export function chatGptLimitsPlanFromHeadings(headings: readonly string[]): "pro_100" | "pro_200" {
  const plans = headings.map(text => text.trim()).filter(text => /^ChatGPT Pro\b/i.test(text));
  if (plans.length === 1 && /^ChatGPT Pro(?: 20x|: More usage)$/i.test(plans[0]!)) return "pro_200";
  if (plans.length === 1 && /^ChatGPT Pro 5x$/i.test(plans[0]!)) return "pro_100";
  throw new Error("Could not distinguish Pro $100 from Pro $200 in ChatGPT billing settings. Limits tracking was not enabled.");
}

export async function detectChatGptLimitsPlan(page: Page): Promise<{ accountKey: string; plan: ChatGptLimitsPlan }> {
  const before = await readChatGptUsageAccount(page);
  if (!supportsChatGptUsageTracking(before)) return { accountKey: before.accountKey, plan: "unsupported" };
  if (before.needsAttention) {
    throw new Error("ChatGPT reports a subscription payment problem. Check your plan in ChatGPT settings before enabling Limits.");
  }
  if (await page.getByRole("dialog").filter({ visible: true }).count() > 0) {
    throw new Error("Close the open ChatGPT dialog and retry Limits setup.");
  }
  let settings: Locator | undefined;
  const returnUrl = page.url();
  let openedSettingsPage = false;
  try {
    const modernComposer = page.locator('form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]')
      .filter({ visible: true });
    const modernCount = await modernComposer.count();
    if (modernCount > 1) throw new Error("Limits could not identify a unique ChatGPT page.");
    let headings: string[];
    if (modernCount === 1) {
      // The new Settings UI has a dedicated route. Open the observed Billing page
      // directly, without depending on translated profile/menu button labels.
      openedSettingsPage = true;
      await page.goto("https://chatgpt.com/settings/billing", { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (page.url() !== "https://chatgpt.com/settings/billing") throw new Error("ChatGPT did not open Billing settings.");
      const subscription = page.locator('main [class~="@container/settings-row"]')
        .filter({ has: page.locator("button") })
        .filter({ has: page.getByText(/^ChatGPT Pro\b/i) });
      // Current subscription rows are separate from invoice tables and upgrade
      // offers. Never activate their subscription controls.
      await subscription.waitFor({ state: "visible", timeout: 10_000 });
      headings = await subscription.getByText(/^ChatGPT Pro\b/i).allTextContents();
    } else {
      // Collapsed and expanded sidebars can both keep a layout-visible profile
      // control in the DOM. Only the hit-testable control can open its menu.
      const profiles = page.getByTestId("accounts-profile-button").filter({ visible: true });
      const actionable = await profiles.evaluateAll(elements => elements.flatMap((element, index) => {
        const rect = element.getBoundingClientRect();
        const hit = element.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit && element.contains(hit) ? [index] : [];
      }));
      if (actionable.length !== 1) throw new Error("Limits could not identify a unique accessible ChatGPT profile control.");
      // Enter targets the profile control itself; a center click can hit its nested payment button.
      await profiles.nth(actionable[0]!).press("Enter", { timeout: 5_000 });
      await page.getByTestId("settings-menu-item").click({ timeout: 5_000 });
      settings = page.getByRole("dialog").filter({ has: page.locator('[role="tab"][id$="-trigger-Billing"]') });
      await settings.waitFor({ state: "visible", timeout: 10_000 });
      await settings.locator('[role="tab"][id$="-trigger-Billing"]').click({ timeout: 5_000 });
      const panel = settings.locator('[role="tabpanel"][id$="-content-Billing"]');
      await panel.getByRole("heading", { name: /^ChatGPT Pro\b/i }).waitFor({ state: "visible", timeout: 10_000 });
      headings = await panel.getByRole("heading").allTextContents();
    }
    const plan = chatGptLimitsPlanFromHeadings(headings);
    const after = await readChatGptUsageAccount(page);
    if (after.accountKey !== before.accountKey || after.planType !== before.planType
      || !supportsChatGptUsageTracking(after) || after.needsAttention) {
      throw new Error("The ChatGPT account or subscription changed during Limits setup. Retry the check.");
    }
    return { accountKey: after.accountKey, plan };
  } finally {
    // Only dismiss the UI opened by this inspection; no subscription controls are activated.
    if (openedSettingsPage && page.url().startsWith("https://chatgpt.com/settings/")) {
      await page.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } else if (settings && await settings.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden", timeout: 5_000 });
    } else if (await page.getByTestId("settings-menu-item").isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
    }
  }
}

/** The slider's own accessibility announcement names the selected family, even for 'Latest'. */
export async function readChatGptUsageModel(slider: Locator, isPro: boolean): Promise<ChatGptUsageModel> {
  if (!isPro) return "other";
  const announcements = await slider.locator("xpath=ancestor::*[@role='menuitem'][1]").evaluate(element => (
    (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
      .map(id => element.ownerDocument.getElementById(id)?.textContent ?? "")
  ));
  return chatGptUsageModelFromAnnouncements(announcements);
}

export function chatGptUsageModelFromAnnouncements(announcements: readonly string[]): ChatGptUsageModel {
  const families = new Set<ChatGptUsageModel>();
  for (const text of announcements) {
    if (/^\s*(?:GPT[-\s])?6(?:\s+Astra)?\s+Pro(?:\s|[,.;]|$)/i.test(text)) families.add("gpt-6-pro");
    if (/^\s*(?:GPT[-\s])?5\.6(?:\s+Sol)?\s+Pro(?:\s|[,.;]|$)/i.test(text)) families.add("gpt-5.6-pro");
  }
  return families.size === 1 ? [...families][0]! : "pro-unknown";
}
