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

/**
 * Add home-relative paths to `cloud_mirror_exclude`, written back as stored
 * (the auth token stays however it was encrypted). The one writer behind
 * "leave these out of the cloud context"; the value stays a comma list the
 * human can read and edit with `cast config cloud_mirror_exclude`.
 */
export function addCloudMirrorExcludes(paths: string[]): string {
  const file = path.join(defaultConfigDir(), "config.json");
  const config = readLocalConfig() ?? {};
  const current = (config.cloud_mirror_exclude ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const next = [...new Set([...current, ...paths.map((p) => p.trim()).filter(Boolean)])].join(",");
  if (next !== (config.cloud_mirror_exclude ?? "")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...config, cloud_mirror_exclude: next }, null, 2), { mode: 0o600 });
  }
  return next;
}
