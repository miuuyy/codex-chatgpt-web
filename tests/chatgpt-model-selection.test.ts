import { expect, test } from "bun:test";
import { chatGptModelFamilyMatches, selectChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["Recente", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true],
    ["GPT-5.6 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[1];
    const selection = selectChatGptModelFamily({} as Parameters<typeof selectChatGptModelFamily>[0], menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test.each(["modern", "legacy"])("model selection opens the %s advanced view and verifies the exact family", async markup => {
  const { createDocument } = require("@mixmark-io/domino");
  for (const family of ["5.6", "6"] as const) {
    const target = family === "6" ? "Recente" : "GPT-5.6 Sol";
    const document = createDocument(`<div role="menu"><div data-model-picker-view="simple">
      <div role="menuitem" aria-hidden="false" ${markup === "modern" ? 'data-model-picker-view-toggle="true"' : 'aria-expanded="false"'}>Selecionar modelo</div>
      <div role="menuitemradio" aria-checked="false">${target}</div>
    </div></div>`);
    const calls: string[] = [];
    const wrap = (elements: Element[]) => ({
      count: async () => elements.length,
      getAttribute: async (name: string) => elements[0]?.getAttribute(name) ?? null,
      waitFor: async () => {
        expect(document.querySelector('[data-model-picker-view]').getAttribute('data-model-picker-view')).toBe('advanced');
      },
      click: async () => {
        expect(elements.length).toBe(1);
        const element = elements[0]!;
        if (element.getAttribute('role') === 'menuitemradio') {
          calls.push(target);
          element.setAttribute('aria-checked', 'true');
        } else {
          calls.push('open');
          document.querySelector('[data-model-picker-view]').setAttribute('data-model-picker-view', 'advanced');
        }
      },
    });
    const menu = { menu: {
      getByRole: (role: string, options: { name: RegExp }) => wrap(
        Array.from(document.querySelectorAll(`[role="${role}"]`) as NodeListOf<Element>)
          .filter(element => options.name.test(element.textContent ?? '')),
      ),
      locator: (selector: string) => wrap(Array.from(document.querySelectorAll(selector))),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[1];
    const page = { keyboard: { press: async (key: string) => { calls.push(key); } } } as Parameters<typeof selectChatGptModelFamily>[0];
    expect(await selectChatGptModelFamily(page, menu, family, async () => menu)).toBe(menu);
    expect(calls).toEqual(['open', target, 'Escape']);
    // A missing or duplicate advanced-view trigger must fail before activating a model.
    document.querySelector('[role="menuitemradio"]').setAttribute('aria-checked', 'false');
    document.querySelector('[data-model-picker-view]').setAttribute('data-model-picker-view', 'simple');
    const trigger = document.querySelector('[role="menuitem"]');
    trigger.parentNode.appendChild(trigger.cloneNode(true));
    calls.length = 0;
    await expect(selectChatGptModelFamily(page, menu, family, async () => menu)).rejects.toThrow('could not be selected and verified');
    expect(calls).toEqual([]);
    document.querySelectorAll('[role="menuitem"]').forEach((element: Element) => element.remove());
    await expect(selectChatGptModelFamily(page, menu, family, async () => menu)).rejects.toThrow('could not be selected and verified');
    expect(calls).toEqual([]);
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
