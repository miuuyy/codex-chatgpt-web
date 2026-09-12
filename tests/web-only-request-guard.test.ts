import { expect, test } from "bun:test";
import { allowWebOnlySmokeRequest, WEB_ONLY_SMOKE_MODELS } from "../scripts/web-only-request-guard";

test("installed smoke cannot forward native models or unrelated endpoints", () => {
  expect(allowWebOnlySmokeRequest("POST", "/v1/responses", "chatgpt-web/pro")).toBe(true);
  expect(allowWebOnlySmokeRequest("POST", "/v1/responses/compact", "chatgpt-web/pro")).toBe(true);
  for (const model of ["gpt-6-astra", "gpt-5.6-sol", "CPA/gpt-5.6-sol", null, {}, "chatgpt-web/pro/other"]) {
    expect(allowWebOnlySmokeRequest("POST", "/v1/responses", model)).toBe(false);
  }
  expect(allowWebOnlySmokeRequest("POST", "/v1/images/generations", "chatgpt-web/pro")).toBe(false);
  expect(allowWebOnlySmokeRequest("GET", "/v1/responses", "chatgpt-web/pro")).toBe(false);
});

test.each(WEB_ONLY_SMOKE_MODELS)("test route stays locked to requested %s", selected => {
  expect(allowWebOnlySmokeRequest("POST", "/v1/responses", selected, selected)).toBe(true);
  for (const model of WEB_ONLY_SMOKE_MODELS.filter(model => model !== selected)) {
    expect(allowWebOnlySmokeRequest("POST", "/v1/responses", model, selected)).toBe(false);
  }
  expect(allowWebOnlySmokeRequest("POST", "/v1/responses", "gpt-6-astra", "gpt-6-astra")).toBe(false);
});
