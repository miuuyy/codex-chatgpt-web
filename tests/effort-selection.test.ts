import { expect, test } from "bun:test";
import {
  chatGptEffortIndexFromControlLabel,
  ChatGptEffortStaleDomError,
  ensureChatGptEffortSelection,
  type ChatGptEffortIndex,
  type ChatGptEffortOpenState,
  type ChatGptEffortSelectionDriver,
} from "../src/adapters/chatgpt-web/effort-selection";

interface Scenario {
  passive?: number;
  open: ChatGptEffortOpenState | Error;
  actual?: number;
  changed?: boolean;
  staleOnce?: boolean;
  replaceOnTransition?: boolean;
  acknowledgementDelayMs?: number;
}

function scenarioDriver(scenario: Scenario) {
  const ledger: string[] = [];
  let stale = scenario.staleOnce === true;
  let generation = 0;
  const driver: ChatGptEffortSelectionDriver = {
    async readCurrent() {
      ledger.push("read-current");
      return scenario.passive;
    },
    async openAndRead() {
      ledger.push(`open:${generation}`);
      if (stale) {
        stale = false;
        generation += 1;
        throw new ChatGptEffortStaleDomError();
      }
      if (scenario.open instanceof Error) throw scenario.open;
      return scenario.open;
    },
    async transition() {
      ledger.push(`transition:${generation}`);
      if (scenario.replaceOnTransition) generation += 1;
      return { changed: scenario.changed ?? true };
    },
    async readActual(_state, _target, signal) {
      ledger.push(`verify:${generation}`);
      if (scenario.acknowledgementDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, scenario.acknowledgementDelayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
      return scenario.actual;
    },
    async close() {
      ledger.push("close");
    },
  };
  return { driver, ledger };
}

const signal = () => new AbortController().signal;

test("already High is proven without opening or interacting", async () => {
  const { driver, ledger } = scenarioDriver({
    passive: 2,
    open: new Error("must not open"),
  });
  expect(await ensureChatGptEffortSelection(driver, 2, signal())).toEqual({ changed: false, transitions: 0 });
  expect(ledger).toEqual(["read-current"]);
});

for (const [name, current] of [["Low", 0], ["Medium", 1]] as const) {
  test(`${name} performs one logical transition to High and verifies actual state`, async () => {
    const { driver, ledger } = scenarioDriver({
      passive: current,
      open: { kind: "menu", optionCount: 5, currentIndex: current, targetLabel: "High" },
      actual: 2,
    });
    expect(await ensureChatGptEffortSelection(driver, 2, signal())).toEqual({ changed: true, transitions: 1 });
    expect(ledger.filter(entry => entry.startsWith("transition"))).toHaveLength(1);
    expect(ledger.at(-1)).toBe("close");
  });
}

test("changed=false passes when authoritative actual state is High", async () => {
  const { driver, ledger } = scenarioDriver({
    passive: 1,
    open: { kind: "menu", optionCount: 5, currentIndex: 1, targetLabel: "High" },
    changed: false,
    actual: 2,
  });
  expect(await ensureChatGptEffortSelection(driver, 2, signal())).toEqual({ changed: false, transitions: 1 });
  expect(ledger).toContain("verify:0");
});

for (const shape of ["legacy-menu", "observed-group-radio"] as const) {
  test(`${shape} uses structural checked index and one High transition`, async () => {
    const { driver, ledger } = scenarioDriver({
      open: { kind: "menu", optionCount: 5, currentIndex: 0, targetLabel: "High" },
      actual: 2,
    });
    await expect(ensureChatGptEffortSelection(driver, 2, signal())).resolves.toMatchObject({ transitions: 1 });
    expect(ledger.filter(entry => entry.startsWith("transition"))).toHaveLength(1);
  });
}

test("previous slider shape transitions by structural range and verifies High", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "slider", min: 0, max: 4, value: 0 },
    actual: 2,
  });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).resolves.toMatchObject({ transitions: 1 });
  expect(ledger).toEqual(["read-current", "open:0", "transition:0", "verify:0", "close"]);
});

test("selector absence fails closed without a transition", async () => {
  const { driver, ledger } = scenarioDriver({ open: new Error("ChatGPT effort control is absent") });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).rejects.toThrow("absent");
  expect(ledger.some(entry => entry.startsWith("transition"))).toBe(false);
});

test("multiple ambiguous selectors fail closed without a transition", async () => {
  const { driver, ledger } = scenarioDriver({ open: new Error("ChatGPT effort menu is ambiguous (visibleCount=2)") });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).rejects.toThrow("ambiguous");
  expect(ledger.some(entry => entry.startsWith("transition"))).toBe(false);
});

test("a stale element receives exactly one bounded DOM re-resolution", async () => {
  const { driver, ledger } = scenarioDriver({
    staleOnce: true,
    open: { kind: "menu", optionCount: 5, currentIndex: 0, targetLabel: "High" },
    actual: 2,
  });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).resolves.toMatchObject({ transitions: 1 });
  expect(ledger.filter(entry => entry.startsWith("open"))).toEqual(["open:0", "open:1"]);
  expect(ledger.filter(entry => entry.startsWith("transition"))).toHaveLength(1);
});

test("a second stale element failure is not retried", async () => {
  let opens = 0;
  const driver = scenarioDriver({
    open: new ChatGptEffortStaleDomError(),
  });
  driver.driver.openAndRead = async () => {
    opens += 1;
    throw new ChatGptEffortStaleDomError();
  };
  await expect(ensureChatGptEffortSelection(driver.driver, 2, signal())).rejects.toBeInstanceOf(ChatGptEffortStaleDomError);
  expect(opens).toBe(2);
});

test("delayed acknowledgement is awaited before PASS", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "menu", optionCount: 5, currentIndex: 1, targetLabel: "High" },
    actual: 2,
    acknowledgementDelayMs: 20,
  });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).resolves.toMatchObject({ transitions: 1 });
  expect(ledger.at(-1)).toBe("close");
});

test("interaction followed by a non-High final state fails closed", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "menu", optionCount: 5, currentIndex: 0, targetLabel: "High" },
    actual: 1,
  });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).rejects.toThrow("actual=1");
  expect(ledger).not.toContain("close");
});

test("model-specific option variation rejects unavailable target", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "slider", min: 0, max: 2, value: 0 },
    actual: 4,
  });
  await expect(ensureChatGptEffortSelection(driver, 4, signal())).rejects.toThrow("optionCount=3");
  expect(ledger.some(entry => entry.startsWith("transition"))).toBe(false);
});

test("an unexpected sixth menu option fails closed before interaction", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "menu", optionCount: 6, currentIndex: 0, targetLabel: "High" },
    actual: 2,
  });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).rejects.toThrow("optionCount=6");
  expect(ledger.some(entry => entry.startsWith("transition"))).toBe(false);
});

test("timeout aborts acknowledgement and never repeats the transition", async () => {
  const controller = new AbortController();
  const { driver, ledger } = scenarioDriver({
    open: { kind: "menu", optionCount: 5, currentIndex: 0, targetLabel: "High" },
    actual: 2,
    acknowledgementDelayMs: 500,
  });
  setTimeout(() => controller.abort(), 10);
  await expect(ensureChatGptEffortSelection(driver, 2, controller.signal)).rejects.toThrow("aborted");
  expect(ledger.filter(entry => entry.startsWith("transition"))).toHaveLength(1);
});

test("DOM replacement during transition is verified from the new generation", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "menu", optionCount: 5, currentIndex: 0, targetLabel: "High" },
    actual: 2,
    replaceOnTransition: true,
  });
  await expect(ensureChatGptEffortSelection(driver, 2, signal())).resolves.toMatchObject({ transitions: 1 });
  expect(ledger).toContain("verify:1");
});

test("all transitions are target-scoped and unrelated interaction remains zero", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "menu", optionCount: 5, currentIndex: 0, targetLabel: "High" },
    actual: 2,
  });
  await ensureChatGptEffortSelection(driver, 2, signal());
  expect(ledger.filter(entry => entry.includes("unrelated"))).toHaveLength(0);
  expect(ledger.filter(entry => entry.startsWith("transition"))).toHaveLength(1);
});

test("current-state labels are read without opening the selector", () => {
  expect(chatGptEffortIndexFromControlLabel("High")).toBe(2);
  expect(chatGptEffortIndexFromControlLabel(" 高い ")).toBe(2);
  expect(chatGptEffortIndexFromControlLabel("Medium")).toBe(1);
  expect(chatGptEffortIndexFromControlLabel("not an effort")).toBeUndefined();
});

test("already-selected open state performs no logical transition", async () => {
  const { driver, ledger } = scenarioDriver({
    open: { kind: "slider", min: 0, max: 4, value: 2 },
    actual: 2,
  });
  expect(await ensureChatGptEffortSelection(driver, 2, signal())).toEqual({ changed: false, transitions: 0 });
  expect(ledger.some(entry => entry.startsWith("transition"))).toBe(false);
});

test("every supported target index remains structurally bounded", async () => {
  for (const target of [0, 1, 2, 3, 4] as ChatGptEffortIndex[]) {
    const { driver } = scenarioDriver({
      open: { kind: "menu", optionCount: 5, currentIndex: target === 0 ? 1 : 0, targetLabel: `target-${target}` },
      actual: target,
    });
    await expect(ensureChatGptEffortSelection(driver, target, signal())).resolves.toMatchObject({ transitions: 1 });
  }
});
