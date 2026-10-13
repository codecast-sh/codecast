/**
 * The person's adjustments to what travels for one repo: the repo's [sync]
 * table in .codecast/workspace.toml plus their own `sync_always` and
 * `sync_never` settings. Read on the laptop and sent with every request, so
 * the host applies exactly the same rules.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readLocalConfig } from "../config/readLocalConfig.js";
import { parseManifest } from "../workspace/manifest.js";
import type { SyncScope } from "./syncSide.js";

const list = (raw: string | undefined) => (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean);

export function readSyncScope(repoRoot: string, config = readLocalConfig()): SyncScope | undefined {
  let spec: { always: string[]; never: string[] } | undefined;
  const file = path.join(repoRoot, ".codecast", "workspace.toml");
  if (fs.existsSync(file)) {
    try { spec = parseManifest(file)?.sync; } catch { /* a broken manifest is reported where it is used; the defaults still apply */ }
  }
  const always = [...(spec?.always ?? []), ...list(config?.sync_always)];
  const never = [...(spec?.never ?? []), ...list(config?.sync_never)];
  return always.length || never.length ? { always, never } : undefined;
}
