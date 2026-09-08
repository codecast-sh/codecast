// Plain read of ~/.codecast/config.json (CODECAST_DIR-aware), no decryption:
// the reader for laptop-side code that needs user_id and the cloud_mirror_*
// keys without pulling index.ts's config pair into its import graph.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./types.js";
import { defaultConfigDir } from "./configDir.js";

/** The config as written, or null when absent/unparseable. */
export function readLocalConfig(): Config | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(defaultConfigDir(), "config.json"), "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Config) : null;
  } catch {
    return null;
  }
}
