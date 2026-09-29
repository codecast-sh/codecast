/**
 * Every cloud agent provider the daemon runs. Adding a provider is one
 * adapter here plus its CLOUD_AGENT_PROVIDERS entry in the shared contracts.
 */
import { defaultConfigDir } from "../config/configDir.js";
import { providerApiKey } from "../providerKeyStore.js";
import { CodexCloudAdapter } from "./codex.js";
import { CursorCloudAdapter } from "./cursor.js";
import type { AnyCloudAgentAdapter } from "./types.js";

export { CloudAgentRegistry, type CloudAgentRuntime } from "./registry.js";
export { CloudAgentSetupError, CloudAgentBusyError, logTag, type CloudAgentGit, type CloudAgentLoginState } from "./types.js";
export { readMetaJson } from "./transcript.js";

export interface CloudAgentAdapterDeps {
  /** Run a provider's own sign-in command where it can open the browser (the daemon's utility tmux pane). */
  runLogin?: (argv: string[]) => Promise<void>;
}

export function cloudAgentAdapters(configDir = defaultConfigDir(), deps: CloudAgentAdapterDeps = {}): AnyCloudAgentAdapter[] {
  return [
    new CursorCloudAdapter({ readKey: () => providerApiKey("cursor", configDir) }),
    new CodexCloudAdapter({ runLogin: deps.runLogin }),
  ];
}
