import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { resolveChatGptToolConfirmation, throwIfChatGptToolApprovalRequired } from "../src/adapters/chatgpt-web/browser-worker";

const domTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);

// Semantic fixture from the Oct 19 screenshot/AX text and the saved role=alert
// checkpoint. This models the permission card, not a verbatim HTML capture.
const inlineApproval = `<div>
  <div>Codex Native2</div>
  <div role="alert"><p>Allow ChatGPT to use Codex Native2?</p>
    <p>ChatGPT will call Codex Native2's Run a native Codex command tool. <button>See details</button></p></div>
  <button>Always allow</button><button>Deny</button>
  <div><button>Allow once</button><button aria-label="Approval options">⌄</button></div>
</div>`;

async function withPage(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try { await run(await browser.newPage()); } finally { await browser.close(); }
}

domTest("the current inline permission card explains the setting even when the configured plugin name differs", async () => {
  await withPage(async page => {
    await page.setContent(`<div data-turn-key="current">${inlineApproval}</div>`);
    await page.locator("button").evaluateAll(buttons => buttons.forEach(button => {
      (button as HTMLElement).onclick = () => { document.body.dataset.clicked = button.textContent!; };
    }));
    for (const configuredName of ["Codex Native2", "Codex app"]) {
      // An unowned surface must never gain automatic-click authority from this diagnosis.
      expect(await resolveChatGptToolConfirmation(page, configuredName, true)).toBeFalse();
      await expect(throwIfChatGptToolApprovalRequired(page.locator('[data-turn-key="current"]')))
        .rejects.toMatchObject({ code: "chatgpt_tool_approval_required", status: 403, retryable: false });
      await expect(throwIfChatGptToolApprovalRequired(page.locator('[data-turn-key="current"]')))
        .rejects.toThrow("Permissions → Allow all actions");
      expect(await page.locator("body").getAttribute("data-clicked")).toBeNull();
    }
  });
}, 20_000);

domTest("permission diagnosis ignores old turns, hidden cards, quoted answers, and ordinary error alerts", async () => {
  await withPage(async page => {
    for (const content of [
      `<div hidden>${inlineApproval}</div>`,
      `<div class="markdown">${inlineApproval}</div>`,
      `<div data-user-message-bubble>${inlineApproval}</div>`,
      '<div role="alert">Something went wrong</div>',
      '<p>Allow ChatGPT to use Codex Native2?</p>',
    ]) {
      await page.setContent(`<div data-turn-key="old">${inlineApproval}</div><div data-turn-key="current">${content}</div>`);
      await expect(throwIfChatGptToolApprovalRequired(page.locator('[data-turn-key="current"]'))).resolves.toBeUndefined();
    }
  });
}, 20_000);

domTest("an unanswered recognized approval reports the setting and leaves all permission buttons untouched", async () => {
  await withPage(async page => {
    await page.setContent(card());
    const pending: boolean[] = [];
    await expect(resolveChatGptToolConfirmation(page, "Codex Native2", false, undefined, 10,
      undefined, async value => { pending.push(value); })).rejects.toMatchObject({
        code: "chatgpt_tool_approval_required", retryable: false,
      });
    expect(pending).toEqual([true, false]);
    expect(await page.locator("section").count()).toBe(1);
    expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
  });
}, 20_000);

// Structure reported in #768: the owned surface contains an alert and a split button.
function card(app = "Codex Native2", actions = "Allow once", attribute = 'data-codex-approval-surface="true"') {
  return `<section ${attribute}><div role="alert"><p>Allow ChatGPT to use ${app}?</p>
    <button onclick="this.closest('section').remove()">Deny</button>
    <div><button onclick="document.body.dataset.chosen=this.textContent;this.closest('section').remove()">${actions}</button>
    <button aria-label="Approval options">Options</button></div></div></section>`;
}

domTest("current and earlier approval surfaces select only the visible one-time action", async () => {
  await withPage(async page => {
    for (const attribute of ['data-codex-approval-surface="true"', 'role="dialog"', 'data-testid="tool-approval-card"']) {
      await page.setContent(card("Codex Native2", "Allow once", attribute) + '<button hidden>Allow once</button>');
      expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeTrue();
      expect(await page.locator("body").getAttribute("data-chosen")).toBe("Allow once");
    }
  });
}, 20_000);

domTest("approval cannot choose another connector, a quoted alert, or ambiguous permission controls", async () => {
  await withPage(async page => {
    for (const html of [card("GitHub"), card("Codex Native2 extra"), card("Codex Native2", "Allow once", 'class="answer-text"')]) {
      await page.setContent(html);
      expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeFalse();
      expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
    }
    for (const html of [card() + card(), card().replace("</section>", "<button>Allow once</button></section>")]) {
      await page.setContent(html);
      let failure: unknown;
      try { await resolveChatGptToolConfirmation(page, "Codex Native2", true); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
    }
  });
}, 20_000);

domTest("a pending current approval stays manual and respects cancellation", async () => {
  await withPage(async page => {
    await page.setContent(card());
    const controller = new AbortController();
    const pending: boolean[] = [];
    let failure: unknown;
    try {
      await resolveChatGptToolConfirmation(page, "Codex Native2", false, controller.signal, 1_000,
        undefined, async value => { pending.push(value); if (value) controller.abort(); });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(pending).toEqual([true, false]);
    expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
  });
}, 20_000);

domTest("an approval waits for its actions to finish mounting", async () => {
  await withPage(async page => {
    await page.setContent(card());
    await page.locator("section").evaluate(element => {
      const buttons = [...element.querySelectorAll("button")];
      buttons.forEach(button => { button.hidden = true; });
      setTimeout(() => buttons.forEach(button => { button.hidden = false; }), 100);
    });
    expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeTrue();
    expect(await page.locator("section").count()).toBe(0);
    expect(await page.locator("body").getAttribute("data-chosen")).toBe("Allow once");
  });
}, 20_000);

domTest("automatic approval waits for the requesting message to finish streaming", async () => {
  await withPage(async page => {
    await page.setContent(card() + '<button data-testid="stop-button">Stop</button>');
    await page.getByRole("button", { name: "Allow once", exact: true }).evaluate(button => {
      (button as HTMLElement).onclick = () => {
        document.body.dataset.chosen = document.querySelector('[data-testid="stop-button"]')
          ? "Invalid conversation body" : "Allow once";
        button.closest("section")!.remove();
      };
    });
    const approval = resolveChatGptToolConfirmation(page, "Codex Native2", true, undefined, 2_000);
    await page.waitForTimeout(150);
    expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
    await page.getByTestId("stop-button").evaluate(button => button.remove());
    expect(await approval).toBeTrue();
    expect(await page.locator("body").getAttribute("data-chosen")).toBe("Allow once");
  });
}, 20_000);

domTest("streaming approval timeout and cancellation never click a permission button", async () => {
  await withPage(async page => {
    for (const cancel of [false, true]) {
      await page.setContent(card() + '<button data-testid="stop-button">Stop</button>');
      const signal = cancel ? AbortSignal.timeout(100) : undefined;
      await expect(resolveChatGptToolConfirmation(page, "Codex Native2", true, signal, 200)).rejects.toThrow();
      expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
      expect(await page.locator("section").count()).toBe(1);
    }
  });
}, 20_000);

// Russian question/action labels observed in the user-provided ChatGPT screenshot.
// Like card(), this is a semantic fixture, not a captured live DOM. Wrapper ownership
// remains separate from localization; an inline card is diagnostic-only below.
function russianCard(app = "Codex Native2") {
  return card(app, "Разрешить один раз")
    .replace(`Allow ChatGPT to use ${app}?`, `Разрешить ChatGPT использовать ${app}?`)
    .replace(">Deny<", ">Отклонить<")
    .replace("</section>", '<button>Всегда разрешать</button><button>Allow Codex Native2 for this conversation</button></section>');
}

domTest("Russian approval selects only the one-time action and matches connector names literally", async () => {
  await withPage(async page => {
    for (const app of ["Codex Native2", "Codex (Native)+2"]) {
      await page.setContent(russianCard(app));
      expect(await resolveChatGptToolConfirmation(page, app, true)).toBeTrue();
      expect(await page.locator("body").getAttribute("data-chosen")).toBe("Разрешить один раз");
    }
    await page.setContent(russianCard("GitHub"));
    expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeFalse();
    expect(await page.locator("body").getAttribute("data-chosen")).toBeNull();
  });
}, 20_000);

domTest("Russian inline approval is diagnosed without granting an unowned card click authority", async () => {
  await withPage(async page => {
    const html = russianCard().replace('data-codex-approval-surface="true"', 'class="inline-card"');
    await page.setContent(html);
    expect(await resolveChatGptToolConfirmation(page, "Codex Native2", true)).toBeFalse();
    await expect(throwIfChatGptToolApprovalRequired(page.locator("body")))
      .rejects.toMatchObject({ code: "chatgpt_tool_approval_required" });
    for (const wrapper of ['hidden', 'class="markdown"', 'data-user-message-bubble']) {
      await page.setContent(`<div ${wrapper}>${html}</div>`);
      await expect(throwIfChatGptToolApprovalRequired(page.locator("body"))).resolves.toBeUndefined();
    }
  });
}, 20_000);
