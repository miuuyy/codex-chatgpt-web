import { expect, test } from "bun:test";
import { copyFor } from "../launcher/src/i18n";

test("supported launcher locales return complete, nonempty dictionaries", () => {
  const english = copyFor("en");
  const keys = Object.keys(english).sort();
  for (const language of ["zh-CN", "zh-TW", "ja"] as const) {
    const translated = copyFor(language);
    expect(Object.keys(translated).sort()).toEqual(keys);
    expect(Object.values(translated).every(text => text.trim().length > 0)).toBe(true);
    expect(translated.install).not.toBe(english.install);
    expect(translated.done).not.toBe(english.done);
  }
});
