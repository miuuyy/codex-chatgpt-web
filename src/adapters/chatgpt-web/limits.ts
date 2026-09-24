import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright-core";

export type ChatGptLimitsPlan = "pro_100" | "pro_200" | "unsupported";
export type ChatGptUsageModel = "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";

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
  if (plans.length === 1 && /^ChatGPT Pro 20x$/i.test(plans[0]!)) return "pro_200";
  if (plans.length === 1 && /^ChatGPT Pro 5x$/i.test(plans[0]!)) return "pro_100";
  throw new Error("Could not distinguish Pro $100 from Pro $200 in ChatGPT billing settings. Limits tracking was not enabled.");
}

export async function detectChatGptLimitsPlan(page: Page): Promise<{ accountKey: string; plan: ChatGptLimitsPlan }> {
  const before = await readChatGptUsageAccount(page);
  if (!before.personal || before.planType !== "pro") return { accountKey: before.accountKey, plan: "unsupported" };
  if (before.needsAttention) {
    throw new Error("ChatGPT reports a subscription payment problem. Check your plan in ChatGPT settings before enabling Limits.");
  }
  if (await page.getByRole("dialog").filter({ visible: true }).count() > 0) {
    throw new Error("Close the open ChatGPT dialog and retry Limits setup.");
  }
  let settings: Locator | undefined;
  const returnUrl = page.url();
  const settingsItem = page.getByTestId("settings-menu-item")
    .or(page.getByRole("menuitem", { name: "Configurações", exact: true }));
  try {
    // Enter targets the profile control itself; a center click can hit its nested payment button.
    await page.getByTestId("accounts-profile-button")
      .or(page.getByRole("button", { name: "Abrir menu do perfil", exact: true }))
      .and(page.locator(':not([aria-busy="true"])'))
      .filter({ visible: true }).press("Enter", { timeout: 10_000 });
    await settingsItem.filter({ visible: true }).click({ timeout: 5_000 });
    settings = page.getByRole("dialog").filter({ has: page.locator('[role="tab"][id$="-trigger-Billing"]') });
    const billing = page.locator('button[data-settings-panel-slug="billing"]').filter({ visible: true });
    await settings.or(billing).first().waitFor({ state: "visible", timeout: 10_000 });
    let headings: string[];
    if (await settings.isVisible()) {
      await settings.locator('[role="tab"][id$="-trigger-Billing"]').click({ timeout: 5_000 });
      const panel = settings.locator('[role="tabpanel"][id$="-content-Billing"]');
      await panel.getByRole("heading", { name: /^ChatGPT Pro\b/i }).waitFor({ state: "visible", timeout: 10_000 });
      headings = await panel.getByRole("heading").allTextContents();
    } else {
      await billing.click({ timeout: 5_000 });
      await page.waitForURL(url => url.origin === "https://chatgpt.com" && url.pathname === "/settings/billing", { timeout: 10_000 });
      // The current subscription is a settings row, not a heading. Invoice rows may
      // mention previous plans, so only read the row owning the Change plan control.
      const currentPlan = page.locator('main [class~="@container/settings-row"]').filter({
        has: page.getByRole("button", { name: "Alterar plano", exact: true }),
      });
      await currentPlan.waitFor({ state: "visible", timeout: 10_000 });
      headings = await currentPlan.getByText(/^ChatGPT Pro\b/i).allTextContents();
    }
    const plan = chatGptLimitsPlanFromHeadings(headings);
    const after = await readChatGptUsageAccount(page);
    if (after.accountKey !== before.accountKey || after.planType !== "pro" || !after.personal || after.needsAttention) {
      throw new Error("The ChatGPT account or subscription changed during Limits setup. Retry the check.");
    }
    return { accountKey: after.accountKey, plan };
  } finally {
    // Only dismiss the UI opened by this inspection; no subscription controls are activated.
    if (page.url() !== returnUrl && new URL(page.url()).origin === "https://chatgpt.com"
      && new URL(page.url()).pathname.startsWith("/settings/")) {
      await page.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } else if (settings && await settings.isVisible().catch(() => false)) {
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden", timeout: 5_000 });
    } else if (await settingsItem.isVisible().catch(() => false)) {
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
