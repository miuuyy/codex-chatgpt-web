import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";

test.each([
  new ChatGptWebAdapterError("Selected model is unavailable", {
    status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false,
  }),
  new DOMException("Selection was cancelled", "AbortError"),
])("model recovery preserves terminal rejection without reloading: %s", async original => {
  let attempts = 0;
  let reloads = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    selectModelAndEffort: async () => { attempts++; throw original; },
  });
  await expect(worker.selectModelAndEffortWithRecovery(
    { reload: async () => { reloads++; } }, "gpt-5.6-sol", "high", {},
  )).rejects.toBe(original);
  expect(attempts).toBe(1);
  expect(reloads).toBe(0);
});

test("selectModelAndEffortWithRecovery reloads page and retries on transient control error", async () => {
  let attempts = 0;
  let reloads = 0;
  let surfacesPrepared = 0;
  const diagnostics: string[] = [];

  const page = {
    reload: async () => {
      reloads += 1;
    },
  };

  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { useSavedChats: true },
    selectModelAndEffort: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ChatGptWebAdapterError("ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.", {
          status: 502,
          errorType: "server_error",
          code: "upstream_server_error",
          retryable: true,
        });
      }
      return { model: "chatgpt-5.6", effort: "high", displayLabel: "High" };
    },
    prepareChatSurface: async () => {
      surfacesPrepared += 1;
    },
  });

  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffortWithRecovery: Function;
  }).selectModelAndEffortWithRecovery;

  const result = await select.call(
    worker,
    page,
    "chatgpt-5.6",
    "high",
    capabilities,
    async (checkpoint: string) => { diagnostics.push(checkpoint); },
    false,
    "5.6",
    false,
  );

  expect(attempts).toBe(2);
  expect(reloads).toBe(1);
  expect(surfacesPrepared).toBe(1);
  expect(result.effort).toBe("high");
  expect(diagnostics).toContain("model-controls-recovery-reload-attempted");
  expect(diagnostics).toContain("model-controls-recovery-reloaded");
});

test("selectModelAndEffortWithRecovery does NOT reload on explicit usage limit error", async () => {
  let attempts = 0;
  let reloads = 0;

  const page = {
    reload: async () => {
      reloads += 1;
    },
  };

  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { useSavedChats: true },
    selectModelAndEffort: async () => {
      attempts += 1;
      throw new ChatGptWebAdapterError(
        "ChatGPT effort slider does not expose item index 4 (min=0; max=3) ChatGPT may have temporarily hidden Pro because you reached its usage limit.",
        {
          status: 502,
          errorType: "server_error",
          code: "upstream_server_error",
          retryable: false,
        },
      );
    },
  });

  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffortWithRecovery: Function;
  }).selectModelAndEffortWithRecovery;

  await expect(
    select.call(
      worker,
      page,
      "chatgpt-5.6",
      "max",
      capabilities,
      undefined,
      false,
      "5.6",
      false,
    ),
  ).rejects.toThrow("usage limit");

  expect(attempts).toBe(1);
  expect(reloads).toBe(0);
});

test("selectModelAndEffortWithRecovery rethrows original error if reload fails", async () => {
  let attempts = 0;
  let reloads = 0;

  const page = {
    reload: async () => {
      reloads += 1;
      throw new Error("Navigation timeout during reload");
    },
  };

  const capabilities = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  const originalError = new ChatGptWebAdapterError("ChatGPT model controls are unavailable.", {
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { useSavedChats: true },
    selectModelAndEffort: async () => {
      attempts += 1;
      throw originalError;
    },
  });

  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffortWithRecovery: Function;
  }).selectModelAndEffortWithRecovery;

  await expect(
    select.call(
      worker,
      page,
      "chatgpt-5.6",
      "high",
      capabilities,
      undefined,
      false,
      "5.6",
      false,
    ),
  ).rejects.toThrow("ChatGPT model controls are unavailable.");

  expect(attempts).toBe(1);
  expect(reloads).toBe(1);
});
