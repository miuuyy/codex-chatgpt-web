import { expect, test } from "bun:test";
import { assertCatalogModelUnchanged } from "../scripts/smoke-codex-catalog-contract";

const nativeModel = {
  slug: "gpt-5.6-sol",
  visibility: "list",
  supported_in_api: true,
  supported_reasoning_levels: [{ effort: "high" }],
};

test("catalog verifier accepts an unchanged native model row", () => {
  const source = { models: [nativeModel] };
  const actual = { models: [{ ...nativeModel }] };

  expect(() => assertCatalogModelUnchanged(source, actual, nativeModel.slug)).not.toThrow();
});

test("catalog verifier rejects a missing native model row", () => {
  expect(() => assertCatalogModelUnchanged(
    { models: [nativeModel] },
    { models: [] },
    nativeModel.slug,
  )).toThrow("Integrated Codex catalog has no gpt-5.6-sol model");
});

test("catalog verifier rejects a mutated native model row", () => {
  expect(() => assertCatalogModelUnchanged(
    { models: [nativeModel] },
    { models: [{ ...nativeModel, multi_agent_version: "v1" }] },
    nativeModel.slug,
  )).toThrow("Codex integration changed the bundled gpt-5.6-sol model contract");
});
