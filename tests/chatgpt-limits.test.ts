import { expect, test } from "bun:test";
import {
  chatGptUsageModelFromAnnouncements,
  detectChatGptLimitsPlan,
  readChatGptUsageAccount,
  supportsChatGptUsageTracking,
} from "../src/adapters/chatgpt-web/limits";
import { readChatGptProPlan } from "../src/browser-login";

test("Limits reads exact personal account tiers without inspecting billing UI", async () => {
  for (const [planType, expected] of [["pro", "pro_200"], ["prolite", "pro_100"], ["promax", "unsupported"], ["free", "unsupported"]] as const) {
    const page = {
      url: () => "https://chatgpt.com/",
      evaluate: async () => ({ userId: "u", accountId: "a", planType, structure: "personal", needsAttention: false }),
      getByRole: () => { throw new Error("Plan detection must not inspect or change the UI"); },
    };
    expect((await detectChatGptLimitsPlan(page as never)).plan).toBe(expected);
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
    url: () => "https://chatgpt.com/",
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

test("the billing tier sizes the composer independently of the model selector", async () => {
  const pageFor = (planType: string) => ({
    url: () => "https://chatgpt.com/",
    evaluate: async () => ({ userId: "u", accountId: "a", planType, structure: "workspace", needsAttention: false }),
  });
  for (const planType of ["pro", "prolite"] as const) {
    expect(await readChatGptProPlan(pageFor(planType) as never)).toBe(true);
  }
  for (const planType of ["team", "plus", "free", "business"] as const) {
    expect(await readChatGptProPlan(pageFor(planType) as never)).toBe(false);
  }
  const unreadable = { url: () => "https://chatgpt.com/", evaluate: async () => { throw new Error("no session"); } };
  expect(await readChatGptProPlan(unreadable as never)).toBe(false);
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


test("usage accounting shares localized model parsing and rejects conflicting evidence", () => {
  for (const separator of ["、", "，", "،", "؛", "：", "—", "。", ",", ";"]) {
    expect(chatGptUsageModelFromAnnouncements([`6 Pro${separator}5 件中 5 番目。`])).toBe("gpt-6-pro");
    expect(chatGptUsageModelFromAnnouncements([`5.6 Pro${separator}position`])).toBe("gpt-5.6-pro");
  }
  for (const other of ["6.1 Pro", "6 Sol Pro", "6 High", "7 Pro"]) {
    expect(chatGptUsageModelFromAnnouncements(["6 Pro", other])).toBe("pro-unknown");
  }
  expect(chatGptUsageModelFromAnnouncements(["6 Pro for better answers"])).toBe("pro-unknown");
});
