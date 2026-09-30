import { expect, test } from "bun:test";
import {
  ChatGptBrowserWorker,
  isChatGptMultipartAcknowledgement,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test("isChatGptMultipartAcknowledgement matches exact, fenced, quoted, and substring acknowledgements", () => {
  const expected = "CODEX_MULTIPART_ACK ctx_50267b34e55f00000000000000000000 3/10 b1e57c8d9e";

  // Exact
  expect(isChatGptMultipartAcknowledgement(expected, expected)).toBeTrue();

  // Whitespace variations
  expect(isChatGptMultipartAcknowledgement(`  \n ${expected} \t \n `, expected)).toBeTrue();
  expect(isChatGptMultipartAcknowledgement(
    "CODEX_MULTIPART_ACK   ctx_50267b34e55f00000000000000000000  3/10   b1e57c8d9e",
    expected,
  )).toBeTrue();

  // Fenced code blocks
  expect(isChatGptMultipartAcknowledgement(`\`\`\`\n${expected}\n\`\`\``, expected)).toBeTrue();
  expect(isChatGptMultipartAcknowledgement(`\`\`\`text\n${expected}\n\`\`\``, expected)).toBeTrue();
  expect(isChatGptMultipartAcknowledgement(`\`\`\`bash\n${expected}\n\`\`\``, expected)).toBeTrue();

  // Quoted or inline backticks
  expect(isChatGptMultipartAcknowledgement(`\`${expected}\``, expected)).toBeTrue();
  expect(isChatGptMultipartAcknowledgement(`"${expected}"`, expected)).toBeTrue();

  // Substring match with preamble or suffix
  expect(isChatGptMultipartAcknowledgement(
    `Understood.\n${expected}\nReady for the next part.`,
    expected,
  )).toBeTrue();

  // Non-matching cases
  expect(isChatGptMultipartAcknowledgement("I have stored the context.", expected)).toBeFalse();
  expect(isChatGptMultipartAcknowledgement(
    "CODEX_MULTIPART_ACK ctx_50267b34e55f00000000000000000000 4/10 b1e57c8d9e",
    expected,
  )).toBeFalse();
  expect(isChatGptMultipartAcknowledgement(
    "CODEX_MULTIPART_ACK ctx_different 3/10 b1e57c8d9e",
    expected,
  )).toBeFalse();
});

test("waitForMultipartAcknowledgement accepts relaxed acknowledgements and marks mismatches retryable", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype);
  const stage = {
    text: "dummy",
    acknowledgement: "CODEX_MULTIPART_ACK ctx_50267b34e55f00000000000000000000 1/2 a1b2c3d4",
    sha256: "a1b2c3d4",
  };

  const createMockLocator = () => {
    const loc: any = {
      isVisible: async () => false,
      press: async () => {},
      count: async () => 1,
      last: () => loc,
      first: () => loc,
      filter: () => loc,
      getByTestId: () => loc,
      getByText: () => loc,
      locator: () => loc,
    };
    return loc;
  };

  const fakePage = {
    isClosed: () => false,
    locator: () => createMockLocator(),
  } as any;

  const fakeBinding = {
    identity: "turn-1",
    locator: createMockLocator(),
  } as any;

  // Case 1: Relaxed match (code block) succeeds
  let snapshotText = `\`\`\`\n${stage.acknowledgement}\n\`\`\``;
  (worker as any).responseDomSnapshot = async () => ({
    responsePresent: true,
    visibleText: snapshotText,
    fullHtml: `<pre><code>${snapshotText}</code></pre>`,
    completionActionVisible: true,
    stoppedThinkingVisible: false,
  });

  const completionTracker = {
    needsToolBatchObservation: () => false,
    observeToolBatch: () => {},
    update: () => true, // simulates completion ready
  };

  await expect((worker as any).waitForMultipartAcknowledgement(
    fakePage,
    fakeBinding,
    {} as any,
    stage,
    Date.now() + 10_000,
    undefined,
    undefined,
    completionTracker,
  )).resolves.toBeUndefined();

  // Case 2: Complete mismatch throws ChatGptWebAdapterError with retryable: true
  snapshotText = "I will now proceed with answering the user question directly...";
  (worker as any).responseDomSnapshot = async () => ({
    responsePresent: true,
    visibleText: snapshotText,
    fullHtml: `<p>${snapshotText}</p>`,
    completionActionVisible: true,
    stoppedThinkingVisible: false,
  });

  let capturedError: any;
  try {
    await (worker as any).waitForMultipartAcknowledgement(
      fakePage,
      fakeBinding,
      {} as any,
      stage,
      Date.now() + 10_000,
      undefined,
      undefined,
      completionTracker,
    );
  } catch (error) {
    capturedError = error;
  }

  expect(capturedError).toBeInstanceOf(ChatGptWebAdapterError);
  expect(capturedError.code).toBe("multipart_protocol_violation");
  expect(capturedError.retryable).toBeTrue();
  expect(capturedError.message).toContain("ChatGPT did not confirm the Bigger Context handoff");
});
