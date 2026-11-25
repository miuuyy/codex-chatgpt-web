import { expect, test } from "bun:test";
import { chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";
import { chatGptUsageModelFromAnnouncements } from "../src/adapters/chatgpt-web/limits";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true], ["6", true], ["GPT-6 Sol", true],
    ["GPT-5.6 Sol", false], ["GPT-6.1 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
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

test("family confirmation verifies the exact Sol or Pro version, including the old Latest picker", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Medium, 2 of 3.", "Medium"], "6", "medium")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6.1 High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});

test("explicit Astra Max verifies the requested Pro route without accepting Ultra or another model", () => {
  expect(chatGptModelFamilyMatches(["6 Astra Max"], "6", "max")).toBeTrue();
  expect(chatGptUsageModelFromAnnouncements(["6 Astra Max"])).toBe("gpt-6-pro");
  for (const description of ["6 Astra Ultra", "6 Astra High", "6 Sol Max", "6.1 Astra Max", "6 Max"]) {
    expect(chatGptModelFamilyMatches([description], "6", "max")).toBeFalse();
    expect(chatGptUsageModelFromAnnouncements([description])).toBe("pro-unknown");
  }
});

test("Simplified Chinese effort announcements preserve exact model and effort verification (#911)", () => {
  for (const [label, effort] of [["即时", "low"], ["中", "medium"], ["高", "high"]] as const) {
    expect(chatGptModelFamilyMatches([`GPT-6 Sol ${label}，第 3 项，共 3 项`, `6 ${label}`], "6", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`5.6 ${label}`], "6", effort)).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Astra ${label}`], "6", effort)).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 ${label}`, "6 Pro"], "6", effort)).toBeFalse();
  }
  for (const effort of ["low", "medium", "xhigh", "max"] as const) {
    expect(chatGptModelFamilyMatches(["6 高"], "6", effort)).toBeFalse();
  }
  for (const label of ["超高", "高级", "高 reasoning", "高 6.1"]) {
    expect(chatGptModelFamilyMatches([`6 ${label}`], "6", "high")).toBeFalse();
  }
});

test("Brazilian Portuguese effort announcements preserve exact model and effort verification", () => {
  // Live pt-BR capture 2026-11-25: slider "6.2 Alta, 3 de 3." and header "5.6 Sol 5.6 Alta".
  for (const [label, effort] of [["Instantânea", "low"], ["Média", "medium"], ["Alta", "high"]] as const) {
    expect(chatGptModelFamilyMatches([`6.2 ${label}, 3 de 3.`, `6.2 ${label}`], "6.2", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`5.6 ${label}, 3 de 3.`, `5.6 Sol 5.6 ${label}`], "5.6", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`5.6 ${label}`], "6", effort)).toBeFalse();
  }
  for (const effort of ["low", "medium", "xhigh", "max"] as const) {
    expect(chatGptModelFamilyMatches(["6 Alta"], "6", effort)).toBeFalse();
  }
  for (const label of ["Extra alta", "Alta 6.1", "Altíssima"]) {
    expect(chatGptModelFamilyMatches([`6 ${label}`], "6", "high")).toBeFalse();
  }
});

test("model verification accepts Unicode announcement punctuation without weakening identity", () => {
  for (const separator of ["、", "，", "،", "؛", "：", "—", "。", ",", ";"]) {
    expect(chatGptModelFamilyMatches([`6 Pro${separator}5 件中 5 番目。`], "6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`GPT-5.6 Sol Pro${separator}translated position`], "5.6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.1 Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Sol Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Pro${separator}position`, "5.6 Pro"], "6", "max")).toBeFalse();
  }
  expect(chatGptModelFamilyMatches(["\u2068６ Pro\u2069、position"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro for better answers"], "6", "max")).toBeFalse();
});

test("repeated picker version verifies GPT-5.6 Pro without accepting conflicting evidence (#875)", () => {
  for (const header of ["5.6 Sol 5.6 Pro", "GPT-5.6 Sol GPT-5.6 Pro"]) {
    const evidence = ["5.6 Pro, 5 of 5.", header];
    expect(chatGptModelFamilyMatches(evidence, "5.6", "max")).toBeTrue();
    expect(chatGptUsageModelFromAnnouncements(evidence)).toBe("gpt-5.6-pro");
    expect(chatGptModelFamilyMatches(evidence, "5.6", "high")).toBeFalse();
    expect(chatGptModelFamilyMatches(evidence, "6", "max")).toBeFalse();
  }
  for (const header of ["5.6 Sol 6 Pro", "5.6 Sol 5.7 Pro", "5.6 Sol 5.6.1 Pro"]) {
    expect(chatGptModelFamilyMatches(["5.6 Pro, 5 of 5.", header], "5.6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([header], "5.6", "high")).toBeFalse();
    expect(chatGptUsageModelFromAnnouncements([header])).toBe("pro-unknown");
  }
  expect(chatGptModelFamilyMatches(["6 Astra 6 Pro"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Astra 6 Pro"], "6", "high")).toBeFalse();
});

test("bare repeated picker versions verify GPT-6 and GPT-6.2 without accepting mismatches", () => {
  for (const [effort, mode] of [["low", "Instant"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra High"], ["max", "Pro"]] as const) {
    const evidence = [`6 ${mode}, 1 of 5.`, `6 6 ${mode}`];
    expect(chatGptModelFamilyMatches(evidence, "6", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches(evidence, "6.2", effort)).toBeFalse();
  }
  expect(chatGptUsageModelFromAnnouncements(["6 Pro, 5 of 5.", "6 6 Pro"])).toBe("gpt-6-pro");
  for (const [effort, mode] of [["low", "Instant"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra High"]] as const) {
    expect(chatGptModelFamilyMatches([`6.2 ${mode}, 2 of 5.`, `6.2 ${mode}`], "6.2", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.2 ${mode}, 2 of 5.`, `6.2 6.2 ${mode}`], "6.2", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.2 ${mode}, 2 of 5.`, `6.2 ${mode}`], "6", effort)).toBeFalse();
  }
  for (const conflicting of ["6 6.2 High", "6.2 6 Pro", "6 6.1 High", "6 5.6 Pro", "6 6"]) {
    expect(chatGptModelFamilyMatches([conflicting], "6", "high")).toBeFalse();
    expect(chatGptModelFamilyMatches([conflicting], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([conflicting], "6.2", "high")).toBeFalse();
    expect(chatGptUsageModelFromAnnouncements([conflicting])).toBe("pro-unknown");
  }
});

test("coexisting Latest and 6 rows resolve 6 to explicit 6 and 6.2 to Latest without collision", async () => {
  const labels = ["Latest", "6", "GPT-5.6 Sol"];
  for (const [family, expectedRow] of [["6", "6"], ["6.2", "Latest"], ["5.6", "GPT-5.6 Sol"]] as const) {
    const matched: string[] = [];
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => {
        const hits = labels.filter(label => options.name.test(label));
        return {
          count: async () => hits.length,
          getAttribute: async () => { matched.push(...hits); return "true"; },
          waitFor: async () => { throw new Error("unexpected wait"); },
        };
      },
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    expect(await selectChatGptModelFamily(menu, family, async () => menu)).toBe(menu);
    expect(matched).toEqual([expectedRow]);
  }
});
