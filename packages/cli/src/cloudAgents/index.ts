/**
 * Every cloud agent provider the daemon runs. Adding a provider is one
 * adapter here plus its CLOUD_AGENT_PROVIDERS entry in the shared contracts.
 */
import { defaultConfigDir } from "../config/configDir.js";
import { providerApiKey } from "../providerKeyStore.js";
import { CursorCloudAdapter } from "./cursor.js";
import type { AnyCloudAgentAdapter } from "./types.js";

export { CloudAgentRegistry, type CloudAgentRuntime } from "./registry.js";
export { CloudAgentSetupError, CloudAgentBusyError } from "./types.js";

export function cloudAgentAdapters(configDir = defaultConfigDir()): AnyCloudAgentAdapter[] {
  return [
    new CursorCloudAdapter({ readKey: () => providerApiKey("cursor", configDir) }),
  ];
}
