import { expect, test } from "bun:test";
import { chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import type { CodexProviderConfig } from "../src/types";

test("changing summary preference preserves the retained main task namespace", () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: "http://localhost:17841/v1",
    chatgptWeb: { solAvailable: true, proAvailable: true, localToolsEnabled: true },
  };
  const source = chatGptWebExecutionNamespace(provider);
  for (const compactionModel of ["extra-high", "5.6-pro", "5.5-pro"] as const) {
    expect(chatGptWebExecutionNamespace({
      ...provider, chatgptWeb: { ...provider.chatgptWeb, compactionModel },
    })).toBe(source);
  }
  // The exclusion is specific to the summary preference: capability changes still isolate work.
  expect(chatGptWebExecutionNamespace({
    ...provider, chatgptWeb: { ...provider.chatgptWeb, localToolsEnabled: false },
  })).not.toBe(source);
});
