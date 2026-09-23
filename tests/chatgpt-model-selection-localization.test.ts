import { expect, test } from "bun:test";
import {
  assertChatGptModelFamily,
  selectChatGptModelFamily,
} from "../src/adapters/chatgpt-web/model-selection";

// Minimal composer-owned menu fixture: labels are observations, not translations
// inferred from a substring such as "Pro". French comes from the reported UI;
// Korean is the observed label in upstream issue #642. 最新 covers zh-CN/zh-TW/ja.
function familyMenu(label: string, description = "6 Pro, 5 sur 5.", selected = false) {
  let checked = selected;
  let expanded = false;
  let selections = 0;
  const menu = {
    menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => Number(options.name.test(label)),
        getAttribute: async () => String(checked),
        waitFor: async () => {
          if (!expanded || !options.name.test(label)) throw new Error("No matching visible model row");
        },
        click: async () => { checked = true; selections++; },
      }),
      locator: () => ({
        count: async () => 1,
        getAttribute: async () => String(expanded),
        click: async () => { expanded = true; },
      }),
    },
    slider: {
      getAttribute: async (name: string) => ({
        "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": "4",
      })[name] ?? null,
      locator: () => ({ evaluate: async () => [description] }),
    },
  } as unknown as Parameters<typeof selectChatGptModelFamily>[1];
  const page = { keyboard: { press: async () => {} } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
  return { page, menu, reopen: async () => menu, selections: () => selections };
}

for (const label of ["Latest", "最新", "GPT-6 Pro", "Le plus récent", "최신"]) {
  test(`selects and verifies the exact model-family row: ${label}`, async () => {
    const fixture = familyMenu(label);
    const menu = await selectChatGptModelFamily(fixture.page, fixture.menu, "6", fixture.reopen);
    expect(fixture.selections()).toBe(1);
    await assertChatGptModelFamily(menu, "6", "max", 4);
  });
}

test("already selected French Latest is verified without toggling models", async () => {
  const fixture = familyMenu("Le plus récent", "6 Pro, 5 sur 5.", true);
  const menu = await selectChatGptModelFamily(fixture.page, fixture.menu, "6", fixture.reopen);
  expect(fixture.selections()).toBe(0);
  await assertChatGptModelFamily(menu, "6", "max", 4);
});

for (const description of ["5.6 Pro, 5 sur 5.", "7 Pro, 5 sur 5.", "6 High, 3 sur 5."]) {
  test(`French Latest does not bypass actual model/effort verification: ${description}`, async () => {
    const fixture = familyMenu("Le plus récent", description, true);
    await expect(assertChatGptModelFamily(fixture.menu, "6", "max", 4))
      .rejects.toMatchObject({ code: "model_version_unavailable", retryable: false });
  });
}

test("unknown labels fail closed without selecting another model", async () => {
  const fixture = familyMenu("Any future model");
  await expect(selectChatGptModelFamily(fixture.page, fixture.menu, "6", fixture.reopen))
    .rejects.toMatchObject({ code: "model_version_unavailable", retryable: false });
  expect(fixture.selections()).toBe(0);
});
