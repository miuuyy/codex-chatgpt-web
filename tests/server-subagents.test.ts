import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

test("rejects encrypted cross-backend delegation before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  config.proAvailable = false;
  let adapterConstructions = 0;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: true,
      input: [{
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "encrypted_content", encrypted_content: "gAAAAABopaque-native-v2-payload" }],
      }],
    }),
  }), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("encrypted cross-backend subagent payload"),
    },
  });
  expect(adapterConstructions).toBe(0);
});
