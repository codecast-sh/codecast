// Raw read-modify-write of the shared ~/.codecast/config.json.
//
// This is the primitive for writers that own ONE field of the file and must
// leave every other field — including the encrypted auth_token — byte-for-byte
// untouched. It deliberately does NOT decrypt or stamp anything; index.ts's
// readConfig/writeConfig remain the auth-aware pair. First extracted from
// vault/vaultRegistry.ts when the browser auto-shot toggle needed the same
// pattern.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./types.js";
import { atomicWriteFile } from "../atomicWrite.js";

export function sharedConfigFile(configDir: string): string {
  return path.join(configDir, "config.json");
}

export function readSharedConfig(configDir: string): Config {
  try {
    const parsed = JSON.parse(fs.readFileSync(sharedConfigFile(configDir), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

// Atomic: every other field belongs to another writer and must survive a
// concurrent read intact.
export function writeSharedConfig(configDir: string, config: Config): void {
  fs.mkdirSync(configDir, { recursive: true });
  atomicWriteFile(sharedConfigFile(configDir), JSON.stringify(config, null, 2) + "\n");
}
