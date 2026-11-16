// Read-only, auth-aware read of ~/.codecast/config.json: parses the file and
// decrypts auth_token, with managed policy laid over it. Null when the file is missing, unparseable, or the token
// cannot be decrypted on this machine. Never writes — index.ts's
// readConfig/writeConfig pair owns the plaintext→encrypted migration. This is
// the reader for hot paths that must stay off index.ts's import graph (the
// claude wrapper, the stable-context hook via fastPath.ts).

import type { Config } from "./types.js";
import { readConfigFile, sharedConfigFile } from "./sharedConfig.js";
import { applyManagedPolicy } from "./managedPolicy.js";
import { bearerFromStored } from "../bearerToken.js";
import { TokenDecryptError } from "../tokenEncryption.js";

// Re-exported so the stable-context fast path can reach the reader and the
// directory it reads from in one dynamic import (fastPath.ts).
export { defaultConfigDir } from "./configDir.js";

export function readAuthConfig(
  configDir: string,
  opts: { onUnreadable?: (message: string) => void } = {},
): Config | null {
  const config = readConfigFile(sharedConfigFile(configDir));
  if (!config) return null;
  if (config.auth_token) {
    try {
      config.auth_token = bearerFromStored(config.auth_token);
    } catch (err) {
      if (err instanceof TokenDecryptError) {
        opts.onUnreadable?.(err.message);
        return null;
      }
      throw err;
    }
  }
  return applyManagedPolicy(config);
}
