import { expect, test } from "bun:test";
import { assertChatGptModelFamily, chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation separates Latest staging from the actual Pro response", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});

test("model selection recognizes 5.6 and (Web) suffixes in Korean and English", async () => {
  for (const [label, accepted] of [
    ["GPT-5.6 Sol", true], ["GPT-5.6 Sol (Web)", true], ["GPT-5.6 Sol (웹)", true],
    ["GPT 5.6", true], ["GPT-5.6 Sol Pro", true], ["GPT-6 Astra", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "5.6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});


test.each(["5.6 Sol Instant", "6 Pro", ""])("generic effort announcements require matching active model evidence: %s", async header => {
  const menu = {
    menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test("GPT-5.6 Sol") ? 1 : 0,
        getAttribute: async () => "true",
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    },
    slider: {
      getAttribute: async (attr: string) => {
        if (attr === "aria-valuemin") return "0";
        if (attr === "aria-valuemax") return "2";
        if (attr === "aria-valuenow") return "0";
        return null;
      },
      evaluate: async () => ["Instant, 1 of 3.", "Use Left and Right arrow keys to adjust power", header],
    },
  } as unknown as Parameters<typeof assertChatGptModelFamily>[0];

  const confirmation = assertChatGptModelFamily(menu, "5.6", "low", 0);
  if (header === "5.6 Sol Instant") await confirmation;
  else await expect(confirmation).rejects.toThrow("could not be selected and verified");
});
