/**
 * Every cloud agent provider the daemon runs. Adding a provider is one
 * adapter here plus its CLOUD_AGENT_PROVIDERS entry in the shared contracts.
 */
import { getProviderKeySpec } from "@codecast/shared/contracts";
import { defaultConfigDir } from "../config/configDir.js";
import { readProviderKeyStore } from "../providerKeyStore.js";
import { CursorCloudAdapter } from "./cursor.js";
import type { AnyCloudAgentAdapter } from "./types.js";

export { CloudAgentRegistry, type CloudAgentRuntime } from "./registry.js";
export { CloudAgentSetupError, CloudAgentBusyError } from "./types.js";

/** A provider API key: the one codecast manages on this machine, else the provider's env var. */
export function providerApiKey(id: string, configDir = defaultConfigDir()): string | null {
  const spec = getProviderKeySpec(id);
  return readProviderKeyStore(configDir)[id] || (spec ? process.env[spec.envVars[0]] : undefined) || null;
}

export function cloudAgentAdapters(configDir = defaultConfigDir()): AnyCloudAgentAdapter[] {
  return [
    new CursorCloudAdapter({ readKey: () => providerApiKey("cursor", configDir) }),
  ];
}
