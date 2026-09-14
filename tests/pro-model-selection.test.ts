import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import observedPicker from "./fixtures/pro-model-picker.json";
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
  checkedFamily?: string;
  latestRoutesToSixAtPro?: boolean;
  familyRowsVisible?: boolean;
  familyRowsInertWhenCollapsed?: boolean;
  descriptionLagReads?: number;
  checkedStateLagReads?: number;
} = {}) {
  let version = options.initialVersion ?? "6", value = 0, submenu = false;
  let checkedFamily = options.checkedFamily ?? options.initialVersion ?? "6";
  let descriptionLagReads = 0;
  let checkedStateLagReads = 0;
  let keyboardFailure: string | undefined;
  const actions: string[] = [];
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
      "aria-valuemin": "0", "aria-valuemax": String(options.max ?? 4), "aria-valuenow": String(value),
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
      ? String(submenu || (!options.familyRowsInertWhenCollapsed && options.familyRowsVisible !== false)) : null,
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
    filter() { return this; },
    isVisible: async () => !options.unavailable && !!option && (options.familyRowsVisible !== false || submenu),
    count: async () => options.unavailable ? 0 : matches.length,
    waitFor: async () => { if (options.unavailable || !option) throw new Error("missing version"); },
    getAttribute: async (attribute: string) => {
      if (attribute !== "aria-checked") return null;
      if (checkedStateLagReads-- > 0) return "false";
      return String(checkedFamily === option?.version);
    },
    click: async () => {
      if (options.familyRowsInertWhenCollapsed && !submenu) throw new Error("model row is inert despite visible geometry");
      if (options.unavailable || (options.familyRowsVisible === false && !submenu) || !option) throw new Error("unavailable version");
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
      if (options.familyRowsVisible === false && !submenu && args.includeHidden !== true) return hidden;
      return radio(args.name);
    },
  };
  const composer = { locator: () => ({ locator: () => control }) };
  const page = {
    evaluate: async (fn: unknown, ids: string[]) => {
      expect(ids).toEqual(["picker-value", "picker-instructions"]);
      const describedValue = descriptionLagReads-- > 0 ? Math.max(0, value - 1) : value;
      const descriptions = options.descriptionTexts ?? [
        `${options.actualVersion ?? (value === 4 ? options.versionAtMax : undefined) ?? version} ${options.effortLabels?.[describedValue] ?? ["Instant", "Medium", "High", "Extra High", "Pro"][describedValue]}，第 ${value + 1} 项，共 ${options.max === undefined ? 5 : options.max + 1} 项。`,
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
    state: () => ({ version, value }),
    setEffort: (next: number) => { value = next; },
    failKeyboardCleanup: (message = "keyboard cleanup failed") => { keyboardFailure = message; },
    select: (requested: string | undefined, effort = "max", stageVersion?: string) => select.call(
      { activeComposer: async () => composer }, page, "gpt-5.6-sol", effort,
      { localToolsEnabled: false, solAvailable: true, proAvailable: true, proModelVersion: requested },
      undefined, stageVersion,
    ),
    send: async (requested: string | undefined, effort = "max") => {
      const send = (ChatGptBrowserWorker.prototype as unknown as {
        sendAttachedPrompt(...args: unknown[]): Promise<unknown>;
      }).sendAttachedPrompt;
      const form = { locator: () => control, getByTestId: () => ({
        waitFor: async () => {}, isEnabled: async () => true,
        press: async () => { actions.push("SEND"); },
      }) };
      return send.call({ activeComposer: async () => ({ locator: () => form }),
        waitForSubmissionAcceptedWithRecovery: async () => "user_turn",
      }, page, {}, undefined, undefined, undefined, undefined, undefined, undefined,
      { modelVersion: requested, effort, uiEffortIndex: effort === "xhigh" ? 3 : 4 });
    },
  };
}

test.each(["5.6", "5.5", "6"])("explicit Pro version %s is selected before effort", async version => {
  const fixture = picker({ initialVersion: "unselected", familyRowsVisible: false });
  await fixture.select(version);
  expect(fixture.state()).toEqual({ version, value: 4 });
  expect(fixture.actions[0]).toBe("open-versions");
  expect(fixture.actions[1]).toBe(`selected:${version}`);
  expect(fixture.actions.slice(2)).toEqual(Array(4).fill(`${version}:ArrowRight`));
});

test("an explicit GPT-6 Astra option is accepted without weakening version proof", async () => {
  const fixture = picker({
    initialVersion: "5.6",
    modelOptions: [
      { role: "menuitemradio", name: "GPT-6 Astra", version: "6" },
      ...observedPicker.options.filter(option => option.version !== "6"),
    ],
  });
  await fixture.select("6");
  expect(fixture.state()).toEqual({ version: "6", value: 4 });
});

test("nearby GPT-6 labels are not accepted as the pinned model", async () => {
  const fixture = picker({
    initialVersion: "5.6",
    modelOptions: [
      { role: "menuitemradio", name: "GPT-6 Mini", version: "6" },
      ...observedPicker.options.filter(option => option.version !== "6"),
    ],
  });
  await expect(fixture.select("6")).rejects.toThrow("6");
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
  await fixture.send("5.6", "xhigh");
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test("an unavailable family menu cannot bypass a mismatched pin", async () => {
  const fixture = picker({ initialVersion: "6", versionTriggerUnavailable: true, familyRowsVisible: false });
  await expect(fixture.select("5.6", "xhigh", "5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).toEqual([]);
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
  ["6", "6 Mini Pro，第 5 项，共 5 项。"],
  ["6", "6.1 Pro，第 5 项，共 5 项。"],
])("a non-Pro or unknown state cannot authorize pinned %s even at slider position 4: %s", async (version, state) => {
  const fixture = picker({ descriptionTexts: [state] });
  fixture.setEffort(4);
  await expect(fixture.send(version)).rejects.toThrow(version);
  expect(fixture.actions).not.toContain("SEND");
});

test.each([
  ["5.6", "GPT-5.6 Sol Pro，第 5 项，共 5 项。"],
  ["5.5", "GPT 5.5 Pro, item 5 of 5."],
  ["6", "GPT-6 Astra Pro, item 5 of 5."],
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

test("Latest must still prove version 6, not silently follow a future model", async () => {
  await expect(picker({ actualVersion: "7" }).select("6")).rejects.toThrow("6");
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

// Localized labels observed in the installed zh-CN picker; availability can vary.
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
  await expect(fixture.select("5.6")).rejects.toThrow("ChatGPT model controls are unavailable");
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

test("a four-level 5.6 picker supports a pinned non-Pro preparation stage", async () => {
  const fixture = picker({ max: 3, effortLabels: chineseEffortLabels });
  await fixture.select("5.6", "xhigh", "5.6");
  await fixture.send("5.6", "xhigh");
  expect(fixture.state()).toEqual({ version: "5.6", value: 3 });
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test.each(["5.6 Pro，第 4 项，共 5 项。", "5.6 High，第 4 项，共 5 项。"])(
  "pinned Extra High rejects a conflicting spoken effort even at position 3: %s", async state => {
    const fixture = picker({ descriptionTexts: [state] });
    fixture.setEffort(3);
    await expect(fixture.send("5.6", "xhigh")).rejects.toThrow();
    expect(fixture.actions).not.toContain("SEND");
  },
);


test("Latest rendering 5.6 must be explicitly pinned before requesting 5.6 Pro", async () => {
  const fixture = picker({
    initialVersion: "5.6", checkedFamily: "6", latestRoutesToSixAtPro: true,
    versionTriggerUnavailable: true,
  });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.state()).toEqual({ version: "5.6", value: 4 });
  expect(fixture.actions).toContain("selected:5.6");
  expect(fixture.actions).not.toContain("open-versions");
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test.each([
  ["5.6", "max", 4], ["5.5", "max", 4], ["5.6", "xhigh", 3],
] as const)("collapsed inert rows are opened before selecting %s %s", async (version, effort, index) => {
  const fixture = picker({
    initialVersion: "5.6", checkedFamily: "6", latestRoutesToSixAtPro: true,
    familyRowsInertWhenCollapsed: true,
    effortLabels: ["Instant", "Medium", "High", "Extra High", "Pro"],
  });
  await fixture.select(version, effort, version);
  await fixture.send(version, effort);
  expect(fixture.actions.slice(0, 2)).toEqual(["open-versions", `selected:${version}`]);
  expect(fixture.state()).toEqual({ version, value: index });
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test("an explicitly checked 5.6 family is reused without selecting it again", async () => {
  const fixture = picker({
    initialVersion: "5.6", checkedFamily: "5.6", latestRoutesToSixAtPro: true,
    versionTriggerUnavailable: true, familyRowsVisible: false, familyRowsInertWhenCollapsed: true,
  });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.state()).toEqual({ version: "5.6", value: 4 });
  expect(fixture.actions).not.toContain("selected:5.6");
  expect(fixture.actions).not.toContain("open-versions");
});

test("Latest rendering 5.6 at low still supports the ordinary GPT-6 Pro route", async () => {
  const fixture = picker({
    initialVersion: "5.6", checkedFamily: "6", latestRoutesToSixAtPro: true,
    versionTriggerUnavailable: true, familyRowsVisible: false,
  });
  await fixture.select("6");
  await fixture.send("6");
  expect(fixture.state()).toEqual({ version: "6", value: 4 });
  expect(fixture.actions).not.toContain("selected:6");
});

test("an asynchronous described effort converges after the numeric Pro slider changes", async () => {
  const fixture = picker({ initialVersion: "5.6", checkedFamily: "5.6", descriptionLagReads: 2 });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test("a freshly clicked model radio may settle its checked state before effort selection", async () => {
  const fixture = picker({ initialVersion: "6", checkedFamily: "6", checkedStateLagReads: 2 });
  await fixture.select("5.6");
  await fixture.send("5.6");
  expect(fixture.actions.filter(action => action === "selected:5.6")).toHaveLength(1);
  expect(fixture.actions.filter(action => action === "SEND")).toHaveLength(1);
});

test("a described effort that never settles still prevents a pinned Pro send", async () => {
  const fixture = picker({ initialVersion: "5.6", checkedFamily: "5.6", descriptionLagReads: Infinity });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});

test("a clicked family that never becomes checked fails before changing effort", async () => {
  const fixture = picker({ initialVersion: "6", checkedFamily: "6", checkedStateLagReads: Infinity });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions.filter(action => action.includes("ArrowRight"))).toHaveLength(0);
  expect(fixture.actions).not.toContain("SEND");
});

test("duplicate exact model rows cannot prove a reusable pin", async () => {
  const fixture = picker({ initialVersion: "5.6", modelOptions: [...observedPicker.options,
    { role: "menuitemradio", name: "GPT-5.6 Sol", version: "5.6" }],
  });
  await expect(fixture.select("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).toEqual([]);
});

test("contradictory described model states cannot authorize a Pro send", async () => {
  const fixture = picker({ descriptionTexts: ["5.6 Pro, item 5 of 5.", "6 Pro, item 5 of 5."] });
  fixture.setEffort(4);
  await expect(fixture.send("5.6")).rejects.toThrow("5.6");
  expect(fixture.actions).not.toContain("SEND");
});
