type JsonObject = Record<string, unknown>;

function catalogModels(value: unknown, label: string): JsonObject[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const models = (value as JsonObject).models;
  if (!Array.isArray(models)) throw new Error(`${label} is missing a models array`);
  return models.filter(model => model && typeof model === "object" && !Array.isArray(model)) as JsonObject[];
}

function modelBySlug(catalog: unknown, slug: string, label: string): JsonObject {
  const model = catalogModels(catalog, label).find(candidate => candidate.slug === slug);
  if (!model) throw new Error(`${label} has no ${slug} model`);
  return model;
}

export function assertCatalogModelUnchanged(
  sourceCatalog: unknown,
  integratedCatalog: unknown,
  slug: string,
): void {
  const source = modelBySlug(sourceCatalog, slug, "Bundled Codex catalog");
  const integrated = modelBySlug(integratedCatalog, slug, "Integrated Codex catalog");
  if (JSON.stringify(integrated) !== JSON.stringify(source)) {
    throw new Error(`Codex integration changed the bundled ${slug} model contract`);
  }
}
