import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

const onePixelPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function webTurnRequest(input: unknown[]): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/light", stream: false, input }),
  });
}

test("rejects a remote image URL before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const response = await responseRequest(webTurnRequest([{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: "https://example.com/cat.png" }],
  }]), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("must be an inline base64 data URL"),
    },
  });
  expect(adapterConstructions).toBe(0);
});

test("rejects an inline image with an unsupported media type before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const response = await responseRequest(webTurnRequest([{
    type: "message",
    role: "user",
    content: [{ type: "input_image", image_url: "data:image/bmp;base64,Qk0=" }],
  }]), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("unsupported media type: image/bmp"),
    },
  });
  expect(adapterConstructions).toBe(0);
});

test("accepts an inline base64 data-URL image and reaches the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  let adapterConstructions = 0;
  const response = await responseRequest(webTurnRequest([{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: onePixelPng }],
  }]), config, () => {
    adapterConstructions += 1;
    return {
      name: "stub",
      runTurn: async (_parsed, _incoming, emit) => {
        emit({ type: "error", message: "stub turn ended" });
      },
    };
  });

  expect(response.status).toBe(200);
  expect(adapterConstructions).toBe(1);
});
