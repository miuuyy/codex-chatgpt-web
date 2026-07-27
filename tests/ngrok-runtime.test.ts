import { expect, test } from "bun:test";
import { ngrokEnvironment, ngrokStartedUrl } from "../src/ngrok-runtime";

test("ngrok readiness accepts only a structured started-tunnel event", () => {
  expect(ngrokStartedUrl(JSON.stringify({
    msg: "started tunnel",
    url: "https://codex.example.ngrok.app",
  }))).toBe("https://codex.example.ngrok.app");
  expect(ngrokStartedUrl(JSON.stringify({ msg: "starting tunnel", url: "https://wrong.example" }))).toBeUndefined();
  expect(ngrokStartedUrl("not json")).toBeUndefined();
});

test("ngrok does not inherit generic HTTP proxy variables", () => {
  expect(ngrokEnvironment({
    HTTP_PROXY: "http://proxy.example",
    HTTPS_PROXY: "http://proxy.example",
    http_proxy: "http://proxy.example",
    https_proxy: "http://proxy.example",
    NGROK_AUTHTOKEN: "preserved",
  })).toEqual({ NGROK_AUTHTOKEN: "preserved" });
});
