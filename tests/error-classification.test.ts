import { expect, test } from "bun:test";
import { adapterFailureFromMessage } from "../src/lib/errors";

test("Temporary Chat surface availability is not classified as model overload", () => {
  const failure = adapterFailureFromMessage(
    "ChatGPT web login is expired or the Temporary Chat surface is unavailable",
  );

  expect(failure.httpStatus).toBe(502);
  expect(failure.error).toMatchObject({ type: "server_error", code: "upstream_server_error" });
});

test("explicit model capacity is classified as retryable overload", () => {
  const failure = adapterFailureFromMessage("Selected model is at capacity. Please try a different model.");

  expect(failure.httpStatus).toBe(503);
  expect(failure.error).toMatchObject({ type: "server_error", code: "server_is_overloaded" });
});

test("model unavailable remains an invalid-model failure instead of overload", () => {
  const failure = adapterFailureFromMessage("Selected model unavailable");

  expect(failure.httpStatus).toBe(400);
  expect(failure.error).toMatchObject({ type: "invalid_request_error", code: "invalid_request_error" });
});
