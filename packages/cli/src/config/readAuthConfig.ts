// Read-only, auth-aware read of ~/.codecast/config.json: parses the file and
// decrypts auth_token. Null when the file is missing, unparseable, or the token
// cannot be decrypted on this machine. Never writes — index.ts's
// readConfig/writeConfig pair owns the plaintext→encrypted migration. This is
// the reader for hot paths that must stay off index.ts's import graph (the
// claude wrapper, the stable-context hook via fastPath.ts).

import * as fs from "node:fs";
import type { Config } from "./types.js";
import { sharedConfigFile } from "./sharedConfig.js";
import { decryptToken, isEncryptedToken, TokenDecryptError } from "../tokenEncryption.js";

export function defaultConfigDir(): string {
  return process.env.HOME + "/.codecast";
}

export function readAuthConfig(
  configDir: string,
  opts: { onUnreadable?: (message: string) => void } = {},
): Config | null {
  const file = sharedConfigFile(configDir);
  let config: Config;
  try {
    if (!fs.existsSync(file)) return null;
    config = JSON.parse(fs.readFileSync(file, "utf-8")) as Config;
  } catch {
    return null;
  }
  if (config.auth_token && isEncryptedToken(config.auth_token)) {
    try {
      config.auth_token = decryptToken(config.auth_token);
    } catch (err) {
      if (err instanceof TokenDecryptError) {
        opts.onUnreadable?.(err.message);
        return null;
      }
      throw err;
    }
  }
  return config;
}
