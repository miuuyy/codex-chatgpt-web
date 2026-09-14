import { expect, test } from "bun:test";
import { ChatGptBrowserWorker, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import observedPicker from "./fixtures/pro-model-picker.json";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import {
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
} from "../src/chatgpt-session";

// The live hidden slider has no aria-valuetext. The owned keyboard menuitem's
// aria-describedby references expose its actual version and effort (sanitized DOM fixture).
function picker(options: {
  unavailable?: boolean;
  actualVersion?: string;
  max?: number;
  descriptionTexts?: readonly string[];
  effortLabels?: readonly string[];
  versionAtMax?: string;
  modelOptions?: Array<{ role: string; name: string; version: string }>;
  initialVersion?: string;
  versionTriggerUnavailable?: boolean;
  numericValueMissing?: boolean;
  checkedFamily?: string;
  latestRoutesToSixAtPro?: boolean;
  familyRowsVisible?: boolean;
  familyRowsInertWhenCollapsed?: boolean;
  descriptionLagReads?: number;
  checkedStateLagReads?: number;
} = {}) {
  let version = options.initialVersion ?? "6", value = 0, submenu = false;
  let checkedFamily = options.checkedFamily ?? options.initialVersion ?? "6";
  let descriptionLagReads = 0, checkedStateLagReads = 0;
  let keyboardFailure: string | undefined;
  const actions: string[] = [];
  const submittedStates: Array<{ version: string; value: number }> = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  };
  const sliderControl = {
    getAttribute: async (name: string) => name === "aria-describedby" ? observedPicker.keyboardControl["aria-describedby"] : null,
    press: async (key: string) => {
    actions.push(`${version}:${key}`);
    value += key === "ArrowRight" ? 1 : -1;
    descriptionLagReads = options.descriptionLagReads ?? 0;
    if (options.latestRoutesToSixAtPro && checkedFamily === "6") version = value === 4 ? "6" : "5.6";
  } };
  const slider = {
    waitFor: async () => {},
    getAttribute: async (name: string) => ({
      "aria-valuemin": "0", "aria-valuemax": String(options.max ?? 4), "aria-valuenow": options.numericValueMissing ? null : String(value),
    })[name] ?? null,
    locator: () => sliderControl,
  };
  const container = {
    filter() { return this; }, last() { return this; }, locator: () => slider,
    isVisible: async () => !submenu, waitFor: async () => {},
  };
  const control = {
    last() { return this; }, waitFor: async () => {}, isVisible: async () => true,
    getAttribute: async (name: string) => name === "aria-controls" ? "picker"
      : name === "aria-expanded" ? "true" : null,
    click: async () => { submenu = false; },
  };
  const versionTrigger = {
    count: async () => 1, waitFor: async () => {},
    getAttribute: async (name: string) => name === "aria-expanded"
      ? String(submenu || (options.familyRowsVisible === true && !options.familyRowsInertWhenCollapsed)) : null,
    click: async () => {
      if (options.versionTriggerUnavailable) throw new Error("family picker is unavailable in this menu state");
      submenu = true; actions.push("open-versions");
    },
  };
  const modelOptions = options.modelOptions ?? observedPicker.options;
  const radio = (name: string | RegExp) => {
    const matches = modelOptions.filter(option => typeof name === "string" ? option.name === name : name.test(option.name));
    const option = matches[0];
    return {
    isVisible: async () => !options.unavailable && !!option && (options.familyRowsVisible === true || submenu),
    count: async () => options.unavailable ? 0 : matches.length,
    waitFor: async () => { if (options.unavailable || !option) throw new Error("missing version"); },
    getAttribute: async (attribute: string) => {
      if (attribute !== "aria-checked") return null;
      if (checkedStateLagReads-- > 0) return "false";
      return String(checkedFamily === option?.version);
    },
    click: async () => {
      if (options.familyRowsInertWhenCollapsed && !submenu) throw new Error("model row is inert despite visible geometry");
      if (options.unavailable || (!submenu && options.familyRowsVisible !== true) || !option) throw new Error("unavailable version");
      checkedFamily = option.version;
      checkedStateLagReads = options.checkedStateLagReads ?? 0;
      version = option.version;
      value = 0; submenu = false; actions.push(`selected:${version}`);
    },
    };
  };
  const menu = {
    filter() { return this; }, last() { return this; }, isVisible: async () => true,
    getByLabel: (name: RegExp) => {
      if (!name.test(observedPicker.triggerLabel)) throw new Error("model trigger does not match observed label");
      return versionTrigger;
    },
    getByRole: (role: string, args: { name: string | RegExp; exact: boolean; includeHidden?: boolean }) => {
      if (role !== "menuitemradio" || !args.exact) throw new Error("expected exact model radio");
      if (!submenu && options.familyRowsVisible !== true && args.includeHidden !== true) return hidden;
      return radio(args.name);
    },
  };
  const composer = { locator: () => ({ locator: () => control }) };
  const page = {
    evaluate: async (fn: unknown, ids: string[]) => {
      expect(ids).toEqual(["picker-value", "picker-instructions"]);
      const describedValue = descriptionLagReads-- > 0 ? Math.max(0, value - 1) : value;
      const descriptions = options.descriptionTexts ?? [
        `${options.actualVersion ?? (value === 4 ? options.versionAtMax : undefined) ?? version} ${options.effortLabels?.[describedValue] ?? (describedValue === 4 ? "Pro" : "Instant")}，第 ${value + 1} 项，共 ${options.max === undefined ? 5 : options.max + 1} 项。`,
        observedPicker.descriptions["picker-instructions"],
      ];
      const previousDocument = (globalThis as any).document;
      (globalThis as any).document = {
        getElementById: (id: string) => {
          const index = ids.indexOf(id);
          return index < 0 ? null : { textContent: descriptions[index] };
        },
      };
      try {
        return (fn as (descriptionIds: string[]) => unknown)(ids);
      } finally {
        if (previousDocument === undefined) delete (globalThis as any).document;
        else (globalThis as any).document = previousDocument;
      }
    },
    locator: (selector: string) => selector === '[id="picker"]' || selector === CHATGPT_EFFORT_MENU_SELECTOR ? menu
      : selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR ? container : hidden,
    keyboard: { press: async () => {
      if (keyboardFailure) throw new Error(keyboardFailure);
    } },
    isClosed: () => false,
  };
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  return {
    actions,
    submittedStates,
    state: () => ({ version, value }),
    setEffort: (next: number) => { value = next; },
    failKeyboardCleanup: (message = "keyboard cleanup failed") => { keyboardFailure = message; },
    select: (requested: string | undefined, effort = "max", stageVersion?: string) => select.call(
      { activeComposer: async () => composer }, page, "gpt-5.6-sol", effort,
      { localToolsEnabled: false, solAvailable: true, proAvailable: true,  },
      undefined, stageVersion ?? (effort === "max" ? requested : undefined),
    ),
    send: async (requested: string | undefined, effort = "max", verifyEffortBeforeSend = false) => {
      const send = (ChatGptBrowserWorker.prototype as unknown as {
        sendAttachedPrompt(...args: unknown[]): Promise<unknown>;
      }).sendAttachedPrompt;
      const form = { locator: () => control, getByTestId: () => ({
        waitFor: async () => {}, isEnabled: async () => true,
        press: async () => { actions.push("SEND"); submittedStates.push({ version, value }); },
      }) };
      return send.call({ activeComposer: async () => ({ locator: () => form }),
        waitForSubmissionAcceptedWithRecovery: async () => "user_turn",
      }, page, {}, undefined, undefined, undefined, undefined, undefined, undefined,
      { modelVersion: requested, effort, uiEffortIndex: ({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 })[effort], verifyEffortBeforeSend });
    },
  };
}

test.each(["5.6", "5.5"])("explicit Pro version %s is selected before effort", async version => {
  const fixture = picker({ initialVersion: "unselected" });
  await fixture.select(version);
  expect(fixture.state()).toEqual({ version, value: 4 });
  expect(fixture.actions[0]).toBe("open-versions");
  expect(fixture.actions[1]).toBe(`selected:${version}`);
  expect(fixture.actions.slice(2)).toEqual(Array(4).fill(`${version}:ArrowRight`));
});

test.each([
  ["5.6", "max", 4], ["5.5", "max", 4], ["5.6", "xhigh", 3],
] as const)("Latest rendering 5.6 is explicitly pinned through inert rows for %s %s", async (version, effort, index) => {
  const fixture = picker({
    initialVersion: "5.6", checkedFamily: "6", latestRoutesToSixAtPro: true,
    familyRowsVisible: true, familyRowsInertWhenCollapsed: true,
    effortLabels: ["Instant", "Medium", "High", "Extra High", "Pro"],
  });
  await fixture.select(version, effort, version);
  await fixture.send(version, effort, true);
  expect(fixture.actions.slice(0, 2)).toEqual(["open-versions", `selected:${version}`]);
  expect(fixture.submittedStates).toEqual([{ version, value: index }]);
});

test("an already-open actionable family list does not need its trigger clicked", async () => {
  const fixture = picker({ familyRowsVisible: true, versionTriggerUnavailable: true });
  await fixture.select("5.6");
  expect(fixture.actions[0]).toBe("selected:5.6");
  expect(fixture.actions).not.toContain("open-versions");
});

test("an exact checked hidden family is reused without reopening the inert list", async () => {
  const fixture = picker({
    initialVersion: "5.6", checkedFamily: "5.6", familyRowsInertWhenCollapsed: true,
    versionTriggerUnavailable: true,
  });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.actions).not.toContain("selected:5.6");
  expect(fixture.actions).not.toContain("open-versions");
});

test("duplicate exact family rows cannot authorize selection or effort changes", async () => {
  const fixture = picker({ initialVersion: "5.6", modelOptions: [...observedPicker.options,
    { role: "menuitemradio", name: "GPT-5.6 Sol", version: "5.6" }],
  });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).toEqual([]);
});

test("numeric effort may precede its described state by a bounded update", async () => {
  const fixture = picker({ initialVersion: "5.6", descriptionLagReads: 2 });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.submittedStates).toEqual([{ version: "5.6", value: 4 }]);
});

test("freshly selected family checked state may settle before changing effort", async () => {
  const fixture = picker({ checkedStateLagReads: 2 });
  await fixture.select("5.6");
  expect(fixture.state()).toEqual({ version: "5.6", value: 4 });
});

test("a described state that never settles still fails without sending", async () => {
  const fixture = picker({ initialVersion: "5.6", descriptionLagReads: Infinity });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.submittedStates).toEqual([]);
});

test("an unchecked selected family cannot advance to effort selection", async () => {
  const fixture = picker({ checkedStateLagReads: Infinity });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).toEqual(["open-versions", "selected:5.6"]);
});





test("model-state verification is independent of aria-describedby order", async () => {
  const fixture = picker({
    initialVersion: "5.6",
    descriptionTexts: [
      observedPicker.descriptions["picker-instructions"],
      "5.6 Pro，第 5 项，共 5 项。",
    ],
  });
  await fixture.select("5.6");
  expect(fixture.state()).toEqual({ version: "5.6", value: 4 });
});

test("a verified family survives the multipart effort change without reopening its model submenu", async () => {
  const fixture = picker({
    initialVersion: "5.6",
    versionTriggerUnavailable: true,
    effortLabels: ["Instant", "Medium", "High", "Extra High", "Pro"],
  });
  await fixture.select("5.6", "xhigh", "5.6");
  expect(fixture.state()).toEqual({ version: "5.6", value: 3 });
  expect(fixture.actions).toEqual(Array(3).fill("5.6:ArrowRight"));
  await fixture.send("5.6", "xhigh", true);
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test("an unavailable family menu cannot bypass a mismatched pin", async () => {
  const fixture = picker({ initialVersion: "6", versionTriggerUnavailable: true });
  await expect(fixture.select("5.6", "xhigh", "5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).toEqual([]);
});

test("two low-effort stages and an Extra High summary retain 5.6 without a Pro send", async () => {
  const fixture = picker({
    initialVersion: "5.6", versionTriggerUnavailable: true,
    effortLabels: ["Instant", "Medium", "High", "Extra High", "Pro"],
  });
  await fixture.select("5.6", "low", "5.6");
  await fixture.send("5.6", "low", true);
  await fixture.send("5.6", "low", true);
  await fixture.select("5.6", "xhigh", "5.6");
  await fixture.send("5.6", "xhigh", true);
  expect(fixture.submittedStates).toEqual([
    { version: "5.6", value: 0 }, { version: "5.6", value: 0 }, { version: "5.6", value: 3 },
  ]);
  expect(fixture.actions).not.toContain("open-versions");
});

test("an unrelated instruction mentioning Pro cannot validate an Instant state", async () => {
  const fixture = picker({
    descriptionTexts: [
      "5.6 Instant，第 1 项，共 5 项。",
      "Choose Pro for the most difficult tasks.",
    ],
  });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
});

test.each([
  ["5.6", "5.6 Instant，第 1 项，共 5 项。 Choose Pro for the most difficult tasks."],
  ["5.6", "5.6 High, choose Pro for difficult tasks."],
  ["5.6", "5.6 Pro is unavailable; choose another mode."],
  ["5.6", "5.6 Pro Max，第 5 项，共 5 项。"],
])("a non-Pro or unknown state cannot authorize pinned %s even at slider position 4: %s", async (version, state) => {
  const fixture = picker({ descriptionTexts: [state] });
  fixture.setEffort(4);
  await expect(fixture.send(version)).rejects.toThrow(version);
  expect(fixture.actions).not.toContain("SEND");
});

test.each([
  ["5.6", "GPT-5.6 Sol Pro，第 5 项，共 5 项。"],
  ["5.5", "GPT 5.5 Pro, item 5 of 5."],
])("an exact pinned %s family and Pro state authorizes one send: %s", async (version, state) => {
  const fixture = picker({ descriptionTexts: [state] });
  fixture.setEffort(4);
  await fixture.send(version);
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test("a missing version stops before any effort or submission can proceed", async () => {
  const fixture = picker({ unavailable: true });
  await expect(fixture.select("5.5")).rejects.toThrow("5.5");
  expect(fixture.actions).toEqual(["open-versions"]);
});

test.each(["6", "7", "5.60", ""])("a mismatched or unverified live label (%s) cannot satisfy pinned 5.6", async actualVersion => {
  const fixture = picker({ actualVersion });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
});



test("a version reset during connector or file attachment prevents the send activation", async () => {
  const fixture = picker({ actualVersion: "6" });
  await expect(fixture.send("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("menu cleanup failure cannot mask a pre-send model mismatch", async () => {
  const fixture = picker({ actualVersion: "6" });
  fixture.failKeyboardCleanup();
  await expect(fixture.send("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("menu cleanup failure still blocks a send after successful verification", async () => {
  const fixture = picker();
  await fixture.select("5.6");
  fixture.failKeyboardCleanup();
  await expect(fixture.send("5.6")).rejects.toThrow("keyboard cleanup failed");
  expect(fixture.actions).not.toContain("SEND");
});

test("a verified 5.6 Pro selection permits one send", async () => {
  const fixture = picker();
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

// Observed in the installed zh-CN picker on 2026-09-12. Choosing 5.6 currently
// exposes four levels; a default five-level picker can switch to 6 at Pro.
const chineseEffortLabels = ["即时", "中", "高", "极高", "Pro"];

test("localized intermediate effort names do not reject a verified 5.6 Pro", async () => {
  const fixture = picker({ effortLabels: chineseEffortLabels });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test.each(chineseEffortLabels.slice(0, 4))("Chinese effort %s cannot authorize a Pro send", async label => {
  const fixture = picker({ descriptionTexts: [`5.6 ${label}，第 5 项，共 5 项。请使用 Pro。`] });
  fixture.setEffort(4);
  await expect(fixture.send("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("a four-level localized pinned picker reports missing Pro without sending", async () => {
  const fixture = picker({ max: 3, effortLabels: chineseEffortLabels });
  await expect(fixture.select("5.6")).rejects.toThrow("only 4 effort levels for model 5.6");
  expect(fixture.actions.filter(action => action.includes("ArrowRight"))).toHaveLength(0);
  expect(fixture.actions).not.toContain("SEND");
});

test("moving the slider to Pro must not silently switch a pinned 5.6 request to 6", async () => {
  const fixture = picker({ effortLabels: chineseEffortLabels, versionAtMax: "6" });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions.filter(action => action.includes("ArrowRight"))).toHaveLength(4);
  expect(fixture.actions).not.toContain("SEND");
});

test("an effort reset to non-Pro prevents the send even when the version still matches", async () => {
  const fixture = picker();
  await fixture.select("5.6");
  fixture.setEffort(2);
  await expect(fixture.send("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("preparatory low-effort stages of pinned Pro stay on that version", async () => {
  const fixture = picker();
  await fixture.select("5.6", "low", "5.6");
  expect(fixture.state()).toEqual({ version: "5.6", value: 0 });
});

test("an ordinary non-Pro route and a legacy unpinned route do not select a version", async () => {
  const ordinary = picker();
  await ordinary.select("5.6", "high");
  expect(ordinary.state()).toEqual({ version: "6", value: 2 });
  expect(ordinary.actions).not.toContain("open-versions");
  const legacy = picker();
  await legacy.select(undefined);
  expect(legacy.state()).toEqual({ version: "6", value: 4 });
  expect(legacy.actions).not.toContain("open-versions");
});

test("a four-level 5.6 picker supports an Extra High summary without entering Pro", async () => {
  const fixture = picker({ max: 3, effortLabels: chineseEffortLabels });
  await fixture.select("5.6", "xhigh", "5.6");
  await fixture.send("5.6", "xhigh", true);
  expect(fixture.state()).toEqual({ version: "5.6", value: 3 });
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test.each(["5.6 Pro，第 4 项，共 5 项。", "5.6 High，第 4 项，共 5 项。"])(
  "strict Extra High rejects a conflicting spoken effort even at position 3: %s", async state => {
    const fixture = picker({ descriptionTexts: [state] });
    fixture.setEffort(3);
    await expect(fixture.send("5.6", "xhigh", true)).rejects.toThrow();
    expect(fixture.actions).not.toContain("SEND");
  },
);

test("strict Extra High with no family pin still checks the live effort before send", async () => {
  const fixture = picker({ descriptionTexts: ["6 Pro，第 5 项，共 5 项。"] });
  fixture.setEffort(4);
  await expect(fixture.send(undefined, "xhigh", true)).rejects.toThrow();
  expect(fixture.actions).not.toContain("SEND");
});

test("explicit compaction stages never upgrade an oversized record to Pro", () => {
  const caps = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", caps, 100_000, 500_000, false).effort).toBe("low");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", caps, 100_000, 600_000, false).effort).toBe("medium");
  expect(() => resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", caps, 104_000, 1_200_000, false)).toThrow();
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", caps, 104_000, 1_200_000).effort).toBe("max");
});

test.each(["6 Pro，第 5 项，共 5 项。", "5.6 Instant，第 1 项，共 5 项。"])(
  "contradictory live state nodes prevent a pinned Pro send: %s", async conflictingState => {
    const fixture = picker({ descriptionTexts: ["5.6 Pro，第 5 项，共 5 项。", conflictingState] });
    fixture.setEffort(4);
    await expect(fixture.send("5.6", "max", true)).rejects.toThrow("5.6");
    expect(fixture.actions).not.toContain("SEND");
  },
);

test("a correct spoken Pro label still cannot bypass a wrong numeric position", async () => {
  const fixture = picker({ descriptionTexts: ["5.6 Pro，第 5 项，共 5 项。"] });
  fixture.setEffort(3);
  await expect(fixture.send("5.6", "max", true)).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("a missing numeric effort prevents send despite a correct spoken Pro state", async () => {
  const fixture = picker({ numericValueMissing: true, descriptionTexts: ["5.6 Pro，第 5 项，共 5 项。"] });
  await expect(fixture.send("5.6", "max", true)).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("missing state nodes cannot authorize a pinned Pro send", async () => {
  const fixture = picker({ descriptionTexts: [] });
  fixture.setEffort(4);
  await expect(fixture.send("5.6", "max", true)).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("model family overrides are explicit and reject unsupported models and versions", () => {
  const caps = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  expect(resolveChatGptWebModelMode("gpt-5.6-sol", "max", caps).modelVersion).toBeUndefined();
  expect(resolveChatGptWebModelMode("gpt-5.6-sol", "low", caps, "5.5").modelVersion).toBe("5.5");
  expect(() => resolveChatGptWebModelMode("gpt-5.6-sol", "max", caps, "6" as "5.6")).toThrow();
  expect(() => resolveChatGptWebModelMode("gpt-5.6-luna", "low", { ...caps, solAvailable: false }, "5.5")).toThrow();
});

const runBrowserTurn = (ChatGptBrowserWorker.prototype as unknown as {
  runBrowserTurn(turn: unknown): Promise<string>;
}).runBrowserTurn;
const summaryTurn = {
  modelId: "gpt-5.6-sol", reasoning: "max", compaction: true,
  capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  compactionExecution: { effort: "max", modelVersion: "5.6" },
};

test.each([
  { compaction: false },
  { reasoning: "high" },
  { capabilities: { ...summaryTurn.capabilities, localToolsEnabled: true } },
  { capabilities: { ...summaryTurn.capabilities, proAvailable: false } },
  { modelId: "gpt-5.6-luna" },
  { compactionExecution: { effort: "max" } },
  { compactionExecution: { effort: "high" } },
  { compactionExecution: { effort: "max", modelVersion: "6" } },
  { reasoning: "xhigh", compactionExecution: { effort: "xhigh" } },
  { reasoning: "xhigh", compactionExecution: { effort: "xhigh", modelVersion: "5.5" } },
  { compactionExecution: { effort: "max", modelVersion: "5.6", extra: true } },
  { compactionExecution: null },
])("invalid explicit compaction fails before preparing any browser input: %j", async override => {
  let prepared = false;
  await expect(runBrowserTurn.call({}, { ...summaryTurn, ...override, prepare: async () => { prepared = true; } }))
    .rejects.toThrow("Explicit compaction execution");
  expect(prepared).toBe(false);
});

test.each([
  { effort: "xhigh", modelVersion: "5.6" },
  { effort: "max", modelVersion: "5.6" },
  { effort: "max", modelVersion: "5.5" },
])("the browser accepts a supported compaction execution: %j", async compactionExecution => {
  let prepared = false;
  await expect(runBrowserTurn.call({}, {
    ...summaryTurn, reasoning: compactionExecution.effort, compactionExecution,
    prepare: async () => { prepared = true; throw new Error("stop before browser access"); },
  })).rejects.toThrow("stop before browser access");
  expect(prepared).toBe(true);
});

test.each([false, true])("read-only compaction allows summary control connector=%s", async nativeConnector => {
  let prepared = false;
  await expect(runBrowserTurn.call({}, { ...summaryTurn, nativeConnector, prepare: async () => {
    prepared = true;
    throw new Error("stop before browser access");
  } })).rejects.toThrow("stop before browser access");
  expect(prepared).toBe(true);
});

test("an indivisible oversized compaction record fails before opening a browser or sending", async () => {
  let browserOpened = false;
  let released = false;
  const record = JSON.stringify({ records: [{ kind: "message", message: { role: "user", content: " ".repeat(1_200_000) } }] });
  await expect(runBrowserTurn.call({
    config: { appName: "Fixture" },
    runStage: async () => { browserOpened = true; throw new Error("unexpected browser access"); },
  }, {
    ...summaryTurn, traceId: "compaction-record-fixture",
    prepare: async () => ({
      text: "", images: [], multipart: { parts: [record, "{}"], commit: "Summarize the full record." },
      release: () => { released = true; },
    }),
  })).rejects.toThrow("No ChatGPT effort available");
  expect(browserOpened).toBe(false);
  expect(released).toBe(true);
}, 20_000);
