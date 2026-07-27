import { expect, test } from "bun:test";
import { ngrokStartedUrl } from "../src/ngrok-runtime";

test("ngrok readiness accepts only a structured started-tunnel event", () => {
  expect(ngrokStartedUrl(JSON.stringify({
    msg: "started tunnel",
    url: "https://codex.example.ngrok.app",
  }))).toBe("https://codex.example.ngrok.app");
  expect(ngrokStartedUrl(JSON.stringify({ msg: "starting tunnel", url: "https://wrong.example" }))).toBeUndefined();
  expect(ngrokStartedUrl("not json")).toBeUndefined();
});
