import { expect, test } from "bun:test";
import {
  nativeRealtimeHeaders,
  nativeRealtimeTarget,
} from "../src/native-realtime-passthrough";

test("builds the native realtime target and preserves authenticated end-to-end headers", () => {
  const request = new Request("http://127.0.0.1:17841/v1/live?session_id=rtc_test", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "downstream-key",
      "sec-websocket-protocol": "realtime",
      "x-oai-attestation": "attestation-token",
    },
  });

  expect(nativeRealtimeTarget(request)).toBe("wss://api.openai.com/v1/live?session_id=rtc_test");
  expect(nativeRealtimeHeaders(request)).toEqual({
    authorization: "Bearer codex-oauth-token",
    "x-oai-attestation": "attestation-token",
  });
});

test("native realtime passthrough fails closed without Codex bearer authentication", () => {
  const request = new Request("http://127.0.0.1:17841/v1/live", {
    headers: { upgrade: "websocket" },
  });
  expect(() => nativeRealtimeHeaders(request)).toThrow(
    "Native Codex realtime passthrough requires the incoming Bearer authorization",
  );
});
