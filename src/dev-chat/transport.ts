import { RemoteTurnBroker, TurnBroker, type TurnBrokerOwner } from "../adapters/chatgpt-web/turn-broker";
import { CHATGPT_CONNECTOR_NAME, DEV_CHATGPT_CONNECTOR_NAME, type AppConfig } from "../config";
import { tunnelStatus, type TunnelRuntimeStatus } from "../tunnel";
import { DEV_CONFIG_PURPOSE } from "./constants";

interface DevTransportDependencies {
  status?: (config: AppConfig) => TunnelRuntimeStatus;
}

export interface DevChatTransport {
  config: AppConfig;
  broker: TurnBrokerOwner;
  close(): Promise<void>;
}

function assertDevTransportConfig(config: AppConfig): void {
  if (config.purpose !== DEV_CONFIG_PURPOSE) {
    throw new Error("Repository DEV transport requires an isolated dev-harness configuration");
  }
  if (config.mode !== "full") {
    throw new Error("Repository DEV chat requires Full mode");
  }
  const standaloneConnector = config.automaticAppName === CHATGPT_CONNECTOR_NAME
    || config.automaticAppName === DEV_CHATGPT_CONNECTOR_NAME;
  if (!config.tunnel && (config.browserInteractionMode !== "automatic" || standaloneConnector)) {
    throw new Error("Repository DEV Full mode requires an existing Routing connector name; rerun DEV setup with --routing-connector-name");
  }
}

/**
 * Attach a named repository DEV chat to the broker owned by the stable DEV runtime.
 * New Routing_MCP mode uses the launcher-owned daemon/broker. Pre-existing tunnel-bearing
 * DEV configs retain their historical per-command broker ownership until migrated.
 */
export async function startDevChatTransport(
  config: AppConfig,
  _devRoot: string,
  dependencies: DevTransportDependencies = {},
): Promise<DevChatTransport> {
  assertDevTransportConfig(config);

  if (!config.tunnel) {
    const broker = new RemoteTurnBroker(config.brokerSocketPath);
    await broker.assertCompatible();
    return { config, broker, close: async () => {} };
  }

  const inspect = dependencies.status ?? tunnelStatus;
  const runtime = inspect(config);
  if (!runtime.ok || !runtime.ready) {
    throw new Error(
      `The legacy launcher-owned DEV MCP tunnel is not ready: ${runtime.detail}. Migrate DEV setup to the Routing connector`,
    );
  }
  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  await broker.listen();
  let closed = false;
  return {
    config,
    broker,
    async close() {
      if (closed) return;
      closed = true;
      await broker.close();
    },
  };
}
