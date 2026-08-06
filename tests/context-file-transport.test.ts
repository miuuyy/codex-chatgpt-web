import { expect, test } from "bun:test";
import {
  CHATGPT_ATTACHMENT_INPUT_STABLE_POLLS,
  chatGptAttachmentsReady,
  chatGptFileInputAcceptsFiles,
  sameExactFileNames,
} from "../src/adapters/chatgpt-web/attachment-readiness";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  CHATGPT_COMPACTION_CONTEXT_FILENAME,
  CHATGPT_TASK_CONTEXT_FILENAME,
  compileChatGptWebPrompt,
  isChatGptWebContextAttachment,
  type CompiledChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

const TURN_TOKEN = "turn_12345678901234567890123456789012";
const PREFIX = "<codex_context_json>\n";
const SUFFIX = "\n</codex_context_json>";

function request(reasoning: "high" | "max" = "high"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

function envelope(compiled: CompiledChatGptWebPrompt): {
  version: number;
  system: string[];
  messages: Array<Record<string, unknown>>;
} {
  const text = compiled.contextAttachment.text;
  expect(text.startsWith(PREFIX)).toBeTrue();
  expect(text.endsWith(SUFFIX)).toBeTrue();
  return JSON.parse(text.slice(PREFIX.length, text.length - SUFFIX.length));
}

test("normal turns attach a plain UTF-8 text document; compaction attaches a ZIP archive", () => {
  const normal = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );
  const readOnly = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: true, proAvailable: true },
  );
  const compactionRequest = request();
  compactionRequest._compactionRequest = true;
  const compaction = compileChatGptWebPrompt(
    compactionRequest,
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(normal.contextAttachment).toMatchObject({
    name: CHATGPT_TASK_CONTEXT_FILENAME,
    mimeType: "text/plain",
  });
  expect(readOnly.contextAttachment).toMatchObject({
    name: CHATGPT_TASK_CONTEXT_FILENAME,
    mimeType: "text/plain",
  });
  expect(compaction.contextAttachment).toMatchObject({
    name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
    mimeType: "application/zip",
  });
  expect(normal.text).toContain(
    `attached UTF-8 text document named ${CHATGPT_TASK_CONTEXT_FILENAME}`,
  );
  expect(compaction.text).toContain(
    `attached ZIP archive named ${CHATGPT_COMPACTION_CONTEXT_FILENAME}`,
  );
  for (const compiled of [normal, readOnly, compaction]) {
    expect(compiled.text).not.toContain("<codex_context_json>");
    expect(compiled.text).not.toContain("</codex_context_json>");
    expect(envelope(compiled)).toMatchObject({
      version: 3,
      system: ["preserve-system"],
    });
  }
  expect(chatGptPromptFilePayloads(normal).map(file => file.name)).toEqual([
    CHATGPT_TASK_CONTEXT_FILENAME,
  ]);
  expect(chatGptPromptFilePayloads(compaction).map(file => file.name)).toEqual([
    CHATGPT_COMPACTION_CONTEXT_FILENAME,
  ]);

  expect(normal.text).toContain(TURN_TOKEN);
  expect(normal.contextAttachment.text).not.toContain(TURN_TOKEN);
  expect(readOnly.text).not.toContain("codex_bind_turn");
  expect(compaction.text).toContain("history-compaction checkpoint");
  expect(compaction.text).not.toContain("codex_bind_turn");
});

test("tiny and large normal contexts use the same file transport without a threshold", () => {
  const tiny = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );
  const beginning = "CONTEXT_BEGIN_7F31";
  const middle = "CONTEXT_MIDDLE_9A82";
  const ending = "CONTEXT_END_4C55";
  const largeRequest = request();
  largeRequest.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: beginning + "x".repeat(300_000) + middle + "y".repeat(300_000) + ending,
    isError: false,
    timestamp: 3,
  });
  const large = compileChatGptWebPrompt(
    largeRequest,
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );

  for (const compiled of [tiny, large]) {
    expect(compiled.text.length).toBeLessThan(10_000);
    expect(compiled.text).not.toContain("<codex_context_json>");
    expect(compiled.contextAttachment.name).toBe(CHATGPT_TASK_CONTEXT_FILENAME);
  }
  expect(large.contextAttachment.text.length).toBeGreaterThan(600_000);
  for (const sentinel of [beginning, middle, ending]) {
    expect(large.contextAttachment.text.match(new RegExp(sentinel, "g"))).toHaveLength(1);
    expect(large.text).not.toContain(sentinel);
  }
});

test("all modes reserve one slot and keep the newest nine images", () => {
  expect(CHATGPT_MAX_INPUT_IMAGES).toBe(9);
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const makeRequest = (compaction: boolean): CodexParsedRequest => ({
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: markers.map((marker, index) => ({
        role: "user" as const,
        content: [
          { type: "text" as const, text: `step ${index + 1}` },
          {
            type: "image" as const,
            imageUrl: `data:image/png;base64,${Buffer.from(marker).toString("base64")}`,
          },
        ],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
    ...(compaction ? { _compactionRequest: true } : {}),
  });

  for (const compaction of [false, true]) {
    const compiled = compileChatGptWebPrompt(
      makeRequest(compaction),
      compaction
        ? { localToolsEnabled: false, proAvailable: true }
        : { localToolsEnabled: true, proAvailable: true },
      compaction ? undefined : TURN_TOKEN,
    );
    expect(compiled.images).toHaveLength(9);
    expect(compiled.contextAttachment.text.match(/older image not attached/g)).toHaveLength(4);
    expect(compiled.contextAttachment.text.match(/"type":"image_attachment"/g)).toHaveLength(9);
    expect(compiled.contextAttachment.text).not.toContain("data:image");
    expect(chatGptPromptFilePayloads(compiled)).toHaveLength(10);
  }
});

test("only compaction turns ZIP the context; normal turns attach raw UTF-8 bytes", () => {
  const normalCompiled = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );
  const normalPayload = chatGptPromptFilePayloads(normalCompiled)[0]!;
  const compactionRequest = request();
  compactionRequest._compactionRequest = true;
  const compactionPayload = chatGptPromptFilePayloads(compileChatGptWebPrompt(
    compactionRequest,
    { localToolsEnabled: false, proAvailable: true },
  ))[0]!;

  expect(normalPayload.mimeType).toBe("text/plain");
  expect(normalPayload.buffer.subarray(0, 2).toString("utf8")).not.toBe("PK");
  expect(normalPayload.buffer.toString("utf8")).toBe(normalCompiled.contextAttachment.text);

  expect(compactionPayload.mimeType).toBe("application/zip");
  expect(compactionPayload.buffer.subarray(0, 2).toString("utf8")).toBe("PK");
});

test("usage accounting always includes attached context text", () => {
  const small = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );
  const largeRequest = request();
  largeRequest.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: "z".repeat(30_000),
    isError: false,
    timestamp: 3,
  });
  const large = compileChatGptWebPrompt(
    largeRequest,
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );
  expect(estimateCompiledChatGptWebInputTokens(large, CHATGPT_WEB_MODEL_ID)).toBeGreaterThan(
    estimateCompiledChatGptWebInputTokens(small, CHATGPT_WEB_MODEL_ID) + 9_000,
  );
});

test("context attachment validation is exact and parses the version-3 envelope", () => {
  const valid = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  ).contextAttachment;
  expect(isChatGptWebContextAttachment(valid)).toBeTrue();
  expect(isChatGptWebContextAttachment({ ...valid, name: "wrong.txt" })).toBeFalse();
  expect(isChatGptWebContextAttachment({ ...valid, mimeType: "application/zip" })).toBeFalse();
  expect(isChatGptWebContextAttachment({ ...valid, text: `${PREFIX}not-json${SUFFIX}` })).toBeFalse();
  expect(isChatGptWebContextAttachment({ ...valid, path: "context.txt" })).toBeFalse();
});

test("document batches never use image-only or single-file inputs", () => {
  const combined = [
    { name: CHATGPT_COMPACTION_CONTEXT_FILENAME, mimeType: "application/zip" },
    { name: "codex-input-image-1.png", mimeType: "image/png" },
  ];
  expect(chatGptFileInputAcceptsFiles({
    accept: "image/*",
    dataTestId: "upload-photos-input",
    disabled: false,
    multiple: true,
  }, combined)).toBeFalse();
  expect(chatGptFileInputAcceptsFiles({
    accept: ".txt,text/plain,image/*",
    dataTestId: "upload-files-input",
    disabled: false,
    multiple: false,
  }, combined)).toBeFalse();
  expect(chatGptFileInputAcceptsFiles({
    accept: ".txt,text/plain,image/*,application/zip",
    dataTestId: "upload-files-input",
    disabled: false,
    multiple: true,
  }, combined)).toBeTrue();
});

test("payload construction rejects missing or duplicated inline context transport", () => {
  const compiled = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, proAvailable: true },
    TURN_TOKEN,
  );
  expect(() => chatGptPromptFilePayloads({
    ...compiled,
    contextAttachment: null,
  } as unknown as CompiledChatGptWebPrompt)).toThrow("missing or invalid");
  expect(() => chatGptPromptFilePayloads({
    ...compiled,
    text: `${compiled.text}\n${compiled.contextAttachment.text}`,
  })).toThrow("duplicated the task context");
});

test("attachment readiness requires exact evidence and the current enabled send control", () => {
  expect(sameExactFileNames(
    ["image.png", CHATGPT_TASK_CONTEXT_FILENAME],
    [CHATGPT_TASK_CONTEXT_FILENAME, "image.png"],
  )).toBeTrue();
  const ready = {
    exactTilesVisible: false,
    exactInputNamePolls: CHATGPT_ATTACHMENT_INPUT_STABLE_POLLS,
    sendVisible: true,
    sendEnabled: true,
    sendAriaDisabled: null,
  };
  expect(chatGptAttachmentsReady(ready)).toBeTrue();
  expect(chatGptAttachmentsReady({ ...ready, sendVisible: false })).toBeFalse();
  expect(chatGptAttachmentsReady({ ...ready, sendEnabled: false })).toBeFalse();
  expect(chatGptAttachmentsReady({ ...ready, sendAriaDisabled: "true" })).toBeFalse();
});
