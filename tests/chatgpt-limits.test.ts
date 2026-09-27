import { expect, test } from "bun:test";
import {
  chatGptLimitsPlanFromHeadings,
  chatGptUsageModelFromAnnouncements,
  detectChatGptLimitsPlan,
  readChatGptUsageAccount,
  supportsChatGptUsageTracking,
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

test("Limits recognizes the current Billing More usage tier without accepting offers or ambiguity", () => {
  expect(chatGptLimitsPlanFromHeadings(["ChatGPT Pro: More usage"])).toBe("pro_200");
  for (const headings of [["More usage"], ["Upgrade to ChatGPT Pro: More usage"],
    ["ChatGPT Pro: More usage", "ChatGPT Pro 5x"], ["ChatGPT Pro: Unknown usage"],
    ["ChatGPT Pro: More usage for $200"]]) {
    expect(() => chatGptLimitsPlanFromHeadings(headings)).toThrow("Could not distinguish");
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
  for (const supported of ["pro", "prolite"]) {
    planType = supported;
    needsAttention = true;
    await expect(detectChatGptLimitsPlan(page as never)).rejects.toThrow("subscription payment problem");
  }
  for (const personal of [false, true]) for (const planType of ["free", "plus", "pro", "prolite", "business", "unknown"]) {
    expect(supportsChatGptUsageTracking({ personal, planType })).toBe(personal && ["pro", "prolite"].includes(planType));
  }
});
