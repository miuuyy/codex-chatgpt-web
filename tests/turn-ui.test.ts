import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { throwIfChatGptThinkingFailed, waitForChatGptConnectorReview } from "../src/adapters/chatgpt-web/turn-ui";

const card = `<div role="alert" id="review"><span>Codex Native2</span>
  <p>Permitir que o ChatGPT use Codex Native2?</p><button>Ver detalhes</button>
  <button>Permitir sempre</button><button>Negar</button><button>Permitir uma vez</button>
  <div role="alert">Instrução suspeita</div></div>`;

function fixture(current: string, outside = "") {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(`<div data-turn-key="old">${outside}</div><div data-turn-key="new" id="current">${current}</div>`);
  const { document } = window;
  const root = document.getElementById("current");
  for (const element of Array.from(document.querySelectorAll("*")) as any[]) {
    Object.defineProperty(element, "isConnected", { get() { return document.contains(this); } });
    element.getBoundingClientRect = () => element.closest("[hidden]") ? { width: 0, height: 0 } : { width: 120, height: 40 };
  }
  const context = createContext({ getComputedStyle: () => ({ visibility: "visible" }) });
  const scope = { evaluate: async (fn: Function, argument: string) => runInContext(`(${fn.toString()})`, context)(root, argument) } as unknown as Locator;
  return { scope, document };
}

test("the observed review card waits for a human decision without clicking any approval control", async () => {
  const { scope, document } = fixture(card);
  let notifications = 0;
  expect(await waitForChatGptConnectorReview(scope, "Codex Native2", undefined, 100, async () => {
    notifications++;
    const review = document.getElementById("review");
    review.parentNode.removeChild(review); // External user decision, never an automated click.
  })).toBeTrue();
  expect(notifications).toBe(1);
});

test.each([
  ["old turn", "", card],
  ["quoted user content", `<div data-user-message-bubble>${card}</div>`, ""],
  ["rendered answer", `<div data-markdown-text-style="assistant-message">${card}</div>`, ""],
  ["another connector", card.replaceAll("Codex Native2", "Other App"), ""],
  ["hidden card", `<div hidden>${card}</div>`, ""],
  ["missing decision control", card.replace("<button>Negar</button>", ""), ""],
  ["duplicate approval action", card.replace("<button>Ver detalhes</button>", "<button>Permitir uma vez</button>"), ""],
])("ignores %s as permission evidence", async (_name, current, outside) => {
  const { scope } = fixture(current!, outside);
  expect(await waitForChatGptConnectorReview(scope, "Codex Native2", undefined, 0)).toBeFalse();
});

test("unanswered review reports a non-retryable approval error, not a missing assistant timeout", async () => {
  const { scope } = fixture(card);
  await expect(waitForChatGptConnectorReview(scope, "Codex Native2", undefined, 0)).rejects.toMatchObject({
    code: "connector_review_required", retryable: false, status: 409,
  });
});

test("review remains cancellable while a card is visible", async () => {
  const { scope } = fixture(card);
  const abort = new AbortController();
  await expect(waitForChatGptConnectorReview(scope, "Codex Native2", abort.signal, 60_000,
    async () => abort.abort())).rejects.toMatchObject({ name: "AbortError" });
});

test("ambiguous review cards fail without choosing one", async () => {
  const { scope } = fixture(card + card);
  await expect(waitForChatGptConnectorReview(scope, "Codex Native2", undefined, 0)).rejects.toMatchObject({
    code: "connector_review_ambiguous", retryable: false,
  });
});

const failedThinking = '<div class="group/activity-header"><span><span>O pensamento falhou</span></span></div>';
test("the observed thinking failure is recognized before an assistant heading exists", async () => {
  await expect(throwIfChatGptThinkingFailed(fixture(failedThinking).scope)).rejects.toMatchObject({
    code: "chatgpt_thinking_failed", retryable: false,
  });
});
test.each([
  ["old turn", "", failedThinking],
  ["user quotation", `<div data-user-message-bubble>${failedThinking}</div>`, ""],
  ["answer quotation", `<div data-markdown-text-style="assistant-message">${failedThinking}</div>`, ""],
  ["code quotation", `<pre>${failedThinking}</pre>`, ""],
  ["hidden status", `<div hidden>${failedThinking}</div>`, ""],
  ["hidden status label", failedThinking.replace("<span>O pensamento", "<span hidden>O pensamento"), ""],
  ["ordinary prose", '<div><span>O pensamento falhou</span></div>', ""],
  ["ongoing reasoning", failedThinking.replaceAll("O pensamento falhou", "Pensando"), ""],
])("does not classify %s as a thinking failure", async (_name, current, outside) => {
  await expect(throwIfChatGptThinkingFailed(fixture(current!, outside).scope)).resolves.toBeUndefined();
});
