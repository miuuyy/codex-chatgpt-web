import { describe, expect, test } from "bun:test";
import {
  cleanCopilotReplyText,
  extractCopilotResponseText,
  isCopilotHost,
  isCopilotPlaceholder,
  isMicrosoftLoginUrl,
} from "../src/copilot/browser";

const marker = "[[codex-transport-turn:abc123]]";
const prompt = `Do the task.\n\n${marker}`;

describe("Copilot transcript extraction", () => {
  test("returns only the text after the current turn marker", () => {
    const transcript = [
      "Old answer",
      "You",
      prompt,
      "Copilot",
      "Here is the answer.",
      "Copy",
    ].join("\n");
    expect(extractCopilotResponseText(transcript, marker, prompt)).toBe("Here is the answer.");
  });

  test("removes a repeated marker without truncating the answer", () => {
    const transcript = [
      prompt,
      "The answer starts here.",
      marker,
      "The answer continues.",
    ].join("\n");
    expect(extractCopilotResponseText(transcript, marker, prompt)).toBe(
      "The answer starts here.\n\nThe answer continues.",
    );
  });

  test("keeps a reply that echoes the marker after the answer", () => {
    expect(cleanCopilotReplyText(`The answer.
${marker}`, marker, prompt)).toBe("The answer.");
  });

  test("falls back to the prompt tail when the marker was virtualized", () => {
    const transcript = `You\n${prompt}\nCopilot\nFallback answer.\nGood response`;
    expect(extractCopilotResponseText(transcript, marker, prompt)).toBe("Fallback answer.");
  });

  test("detects empty and progress placeholders", () => {
    expect(isCopilotPlaceholder("")).toBe(true);
    expect(isCopilotPlaceholder("Thinking...")).toBe(true);
    expect(isCopilotPlaceholder("Working")).toBe(true);
    expect(isCopilotPlaceholder("A real answer.")).toBe(false);
  });

  test("distinguishes Copilot hosts from Microsoft sign-in hosts", () => {
    expect(isCopilotHost("https://copilot.cloud.microsoft/chat")).toBe(true);
    expect(isCopilotHost("https://m365.cloud.microsoft/chat")).toBe(true);
    expect(isCopilotHost("https://www.microsoft365.com/chat")).toBe(true);
    expect(isCopilotHost("https://login.microsoftonline.com/common/oauth2/authorize")).toBe(false);
    expect(isCopilotHost("not a url")).toBe(false);

    expect(isMicrosoftLoginUrl("https://login.microsoftonline.com/common/oauth2/authorize")).toBe(true);
    expect(isMicrosoftLoginUrl("https://login.live.com/oauth20_authorize.srf")).toBe(true);
    expect(isMicrosoftLoginUrl("https://copilot.cloud.microsoft/chat")).toBe(false);
    expect(isMicrosoftLoginUrl("not a url")).toBe(false);
  });
});
