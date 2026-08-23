import { TurnBroker } from "../adapters/chatgpt-web/turn-broker";
import type { AppConfig } from "../config";
import { tunnelStatus, type TunnelRuntimeStatus } from "../tunnel";
import { DEV_CONFIG_PURPOSE } from "./constants";

interface DevTransportDependencies {
  status?: (config: AppConfig) => TunnelRuntimeStatus;
}

export interface DevChatTransport {
  config: AppConfig;
  broker: TurnBroker;
  close(): Promise<void>;
}

function assertDevTransportConfig(config: AppConfig): void {
  if (config.purpose !== DEV_CONFIG_PURPOSE) {
    throw new Error("Repository DEV transport requires an isolated dev-harness configuration");
  }
  if (config.mode !== "full" || !config.tunnel) {
    throw new Error("Repository DEV chat requires completed Full harness tunnel credentials");
  }
}

/**
 * Attach a named repository DEV chat to the broker endpoint owned by the already-running isolated
 * launcher tunnel. The CLI owns only its turn broker; the launcher owns tunnel supervision.
 */
export async function startDevChatTransport(
  config: AppConfig,
  _devRoot: string,
  dependencies: DevTransportDependencies = {},
): Promise<DevChatTransport> {
  assertDevTransportConfig(config);
  const inspect = dependencies.status ?? tunnelStatus;
  const runtime = inspect(config);
  if (!runtime.ok || !runtime.ready) {
    throw new Error(
      `The launcher-owned DEV MCP tunnel is not ready: ${runtime.detail}. Open the DEV launcher and complete MCP setup first`,
    );
  }

  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  await broker.listen();
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await broker.close();
  };

  return { config, broker, close };
}
