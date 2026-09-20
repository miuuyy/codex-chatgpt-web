import { expect, test } from "bun:test";
import type { Locator } from "playwright-core";
import { insertPlainTextIntoComposer, waitForChatGptConnectorMention } from "../src/adapters/chatgpt-web/browser-worker";

function fixture(initial: string, repairs = true, available = true) {
  let text = initial;
  let edits = 0;
  let waits = 0;
  const timeout = Object.assign(new Error("row absent"), { name: "TimeoutError" });
  const composer = {
    fill: async (value: string) => { text = value; },
    evaluate: async (fn: unknown, value?: string) => {
      if (value === undefined) return text;
      expect(fn).toBe(insertPlainTextIntoComposer);
      edits += 1;
      if (repairs) text = value;
      return repairs;
    },
  } as unknown as Locator;
  const row = {
    waitFor: async () => {
      waits += 1;
      if (waits === 1 || !available) throw timeout;
    },
  } as unknown as Locator;
  return { composer, row, timeout, counts: () => ({ edits, waits }) };
}

for (const draft of ["", "@co"]) test(`recovers lost mention input (${JSON.stringify(draft)}) before checking catalog`, async () => {
  const f = fixture(draft);
  await waitForChatGptConnectorMention(f.composer, f.row);
  expect(f.counts()).toEqual({ edits: 1, waits: 2 });
});

test("preserved mention with missing connector retains the catalog timeout", async () => {
  const f = fixture("@codex");
  await expect(waitForChatGptConnectorMention(f.composer, f.row)).rejects.toBe(f.timeout);
  expect(f.counts()).toEqual({ edits: 0, waits: 1 });
});

test("failed mention recovery reports input integrity, not a missing connector", async () => {
  const f = fixture("", false);
  await expect(waitForChatGptConnectorMention(f.composer, f.row)).rejects.toMatchObject({
    code: "prompt_attachment_integrity",
    message: expect.stringContaining("connector availability could not be checked"),
  });
  expect(f.counts()).toEqual({ edits: 1, waits: 1 });
});

test("mention recovery never substitutes for observing the exact connector row", async () => {
  const f = fixture("", true, false);
  await expect(waitForChatGptConnectorMention(f.composer, f.row)).rejects.toBe(f.timeout);
  expect(f.counts()).toEqual({ edits: 1, waits: 2 });
});

test("aborted mention lookup cannot start a recovery edit", async () => {
  const f = fixture("");
  const controller = new AbortController();
  controller.abort();
  await expect(waitForChatGptConnectorMention(f.composer, f.row, controller.signal)).rejects.toThrow();
  expect(f.counts().edits).toBe(0);
});
