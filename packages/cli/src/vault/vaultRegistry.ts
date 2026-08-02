// Registered vaults, persisted under the `vaults` key of ~/.codecast/config.json
// (the same file the CLI, the daemon, and the wrapper already share). A vault is
// just a directory of markdown the user pointed us at; registering it is what
// makes it addressable by id over the loopback bridge, so the browser never
// sends a raw filesystem path.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { VaultInfo } from "@codecast/shared/contracts";
import type { Config } from "../config/types.js";

function configFile(configDir: string): string {
  return path.join(configDir, "config.json");
}

function readConfig(configDir: string): Config {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(configDir), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

// Read-modify-write of the shared config file, atomically: every other field
// belongs to another writer and must survive untouched.
function writeConfig(configDir: string, config: Config): void {
  const file = configFile(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Stable vault id: 12-hex sha256 prefix of the absolute root path. Derived, not
 *  stored-and-generated, so the same directory registered twice is the same
 *  vault on every machine and after any config rewrite. */
export function vaultId(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

export function listVaults(configDir: string): VaultInfo[] {
  const raw = readConfig(configDir).vaults;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is VaultInfo =>
      !!v && typeof v === "object" && typeof v.id === "string" && typeof v.root === "string",
  );
}

/** Look a vault up by id, or by absolute root path (what the CLI accepts). */
export function findVault(configDir: string, idOrPath: string): VaultInfo | null {
  const vaults = listVaults(configDir);
  const byId = vaults.find((v) => v.id === idOrPath);
  if (byId) return byId;
  const resolved = path.resolve(idOrPath);
  return vaults.find((v) => v.root === resolved || v.id === vaultId(resolved)) ?? null;
}

/** Register a directory as a vault. Re-registering an existing root is a no-op
 *  apart from an explicit rename, so `cast vault add` is safe to repeat. */
export function addVault(configDir: string, dir: string, name?: string): VaultInfo {
  const root = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`No such directory: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const config = readConfig(configDir);
  const vaults = listVaults(configDir);
  const id = vaultId(root);
  const existing = vaults.find((v) => v.id === id);
  if (existing) {
    if (name && name !== existing.name) {
      existing.name = name;
      config.vaults = vaults;
      writeConfig(configDir, config);
    }
    return existing;
  }

  const vault: VaultInfo = {
    id,
    root,
    name: name || path.basename(root) || root,
    added_at: Date.now(),
  };
  config.vaults = [...vaults, vault];
  writeConfig(configDir, config);
  return vault;
}

/** Unregister a vault by id or root path. Returns the removed entry, or null if
 *  nothing matched. The directory itself is never touched. */
export function removeVault(configDir: string, idOrPath: string): VaultInfo | null {
  const target = findVault(configDir, idOrPath);
  if (!target) return null;
  const config = readConfig(configDir);
  config.vaults = listVaults(configDir).filter((v) => v.id !== target.id);
  writeConfig(configDir, config);
  return target;
}

/** Turn the remote mirror on or off for one vault. Off by DEFAULT and off is a
 *  real off: the daemon tears the Convex projection down rather than leaving it
 *  stale (see vaultMirror.ts). Returns the updated vault, or null if unknown. */
export function setVaultMirroring(configDir: string, idOrPath: string, on: boolean): VaultInfo | null {
  const target = findVault(configDir, idOrPath);
  if (!target) return null;
  const vaults = listVaults(configDir);
  const vault = vaults.find((v) => v.id === target.id);
  if (!vault) return null;
  vault.mirror = on;
  const config = readConfig(configDir);
  config.vaults = vaults;
  writeConfig(configDir, config);
  return vault;
}

/** Record a fresh note count from a scan. Advisory only — written back solely
 *  when it changed, so a scan doesn't rewrite the shared config on every call. */
export function setVaultNoteCount(configDir: string, id: string, noteCount: number): void {
  const vaults = listVaults(configDir);
  const vault = vaults.find((v) => v.id === id);
  if (!vault || vault.note_count === noteCount) return;
  vault.note_count = noteCount;
  const config = readConfig(configDir);
  config.vaults = vaults;
  writeConfig(configDir, config);
}
