const CURRENT_CONNECTOR_NAME = "Codex Native2";
const LEGACY_CONNECTOR_NAMES = Object.freeze(["Codex Native"]);

function validateConnectorName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("Connector name is invalid");
  }
  return value.trim();
}

function isLegacyConnectorName(value) {
  return LEGACY_CONNECTOR_NAMES.includes(value);
}

function connectorNameForSetup(value) {
  const configured = validateConnectorName(value);
  return isLegacyConnectorName(configured) ? CURRENT_CONNECTOR_NAME : configured;
}

function requireCurrentRuntimeConnectorName(value) {
  const configured = validateConnectorName(value);
  if (isLegacyConnectorName(configured)) {
    throw new Error(
      `The local runtime still targets legacy ChatGPT connector ${JSON.stringify(configured)}. Reconnect the harness`
      + ` so it targets ${JSON.stringify(CURRENT_CONNECTOR_NAME)}, then create that connector as a new ChatGPT plugin;`
      + ` do not rename or refresh the legacy connector.`,
    );
  }
  return configured;
}

module.exports = {
  connectorNameForSetup,
  CURRENT_CONNECTOR_NAME,
  isLegacyConnectorName,
  LEGACY_CONNECTOR_NAMES,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
};
