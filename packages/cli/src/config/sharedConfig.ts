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

// A merge seam, not a second resolver: ct-49848 moved defaultConfigDir here and
// its snippets.ts imports it from this module. The definition lives in
// configDir.ts (one resolver, guarded by config/configDir.guard.test.ts); this
// line only keeps that import path valid. Delete it once no one imports the
// name from here.
export { defaultConfigDir } from "./configDir.js";

export function sharedConfigFile(configDir: string): string {
  return path.join(configDir, "config.json");
}

/** config.json as written, or null when absent or unparseable. The one parse every config reader starts from. */
export function readConfigFile(file: string): Config | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Config) : null;
  } catch {
    return null;
  }
}

/** Raw, for read-modify-write: no managed policy overlay, so a write never stores a managed value. */
export function readSharedConfig(configDir: string): Config {
  return readConfigFile(sharedConfigFile(configDir)) ?? {};
}

// Atomic: every other field belongs to another writer and must survive a
// concurrent read intact.
export function writeSharedConfig(configDir: string, config: Config): void {
  fs.mkdirSync(configDir, { recursive: true });
  atomicWriteFile(sharedConfigFile(configDir), JSON.stringify(config, null, 2) + "\n");
}
