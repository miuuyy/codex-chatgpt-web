function isIntegrationMode(value) {
  return value === "direct" || value === "external-provider";
}

/**
 * Resolve who owns Codex routing. An explicit external-provider value always wins over a
 * missing or retired field such as bridgeEnabled, so a partially migrated launcher state
 * cannot silently take over openai_base_url.
 */
function resolveIntegrationMode(value) {
  const primary = value?.integrationMode;
  const legacy = value?.codexIntegrationMode;
  if (primary === "external-provider" || legacy === "external-provider") return "external-provider";
  if (isIntegrationMode(primary)) return primary;
  if (isIntegrationMode(legacy)) return legacy;
  return "direct";
}

function isExternalProviderMode(value) {
  return resolveIntegrationMode(value) === "external-provider";
}

module.exports = {
  isExternalProviderMode,
  isIntegrationMode,
  resolveIntegrationMode,
};
