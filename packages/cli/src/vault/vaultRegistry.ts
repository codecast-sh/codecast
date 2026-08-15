// Registered vaults, persisted under the `vaults` key of ~/.codecast/config.json
// (the same file the CLI, the daemon, and the wrapper already share). A vault is
// just a directory of markdown the user pointed us at; registering it is what
// makes it addressable by id over the loopback bridge, so the browser never
// sends a raw filesystem path.
//
// PROJECT VAULTS. Requiring `cast vault add` was the wrong shape for the main
// case: codecast already knows every project the user works in, and those repos
// already hold READMEs, docs/ and design notes. So the registry reports the
// user's projects as vaults too, discovered rather than registered.
//
// This is the ONLY place that knows the difference, and it is deliberately so.
// Every vault route resolves through exactly two functions here — listVaults
// (what GET /vault/roots returns) and findVault (what every scan, read, write,
// op and watch request resolves through). Teaching those two about project
// roots makes a project browsable end to end without one line of change in the
// server, the watcher, or the browser: scan, search, backlinks, graph, editing
// and rename-with-link-rewrite all work because nothing downstream can tell the
// two apart.
//
// Discovery is EPHEMERAL until the vault is opened. Writing three hundred
// config entries for repos nobody looks at would be worse than the problem;
// instead findVault materializes an entry the first time a project vault is
// actually addressed, which is exactly the moment it stops being hypothetical.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { VaultInfo } from "@codecast/shared/contracts";
import { enumerateProjectRoots } from "../projectRoots.js";
import { probeProjectVault } from "./vaultScope.js";
import { readSharedConfig as readConfig, writeSharedConfig as writeConfig } from "../config/sharedConfig.js";

/** Stable vault id: 12-hex sha256 prefix of the absolute root path. Derived, not
 *  stored-and-generated, so the same directory registered twice is the same
 *  vault on every machine and after any config rewrite. */
export function vaultId(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

/** Vaults someone added by hand, exactly as config.json holds them. This is the
 *  list every WRITE reads and rewrites — discovery must never leak into it, or
 *  removing one vault would silently persist three hundred others. */
export function registeredVaults(configDir: string): VaultInfo[] {
  const raw = readConfig(configDir).vaults;
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(
    (v): v is VaultInfo =>
      !!v && typeof v === "object" && typeof v.id === "string" && typeof v.root === "string",
  );
  // First entry per id wins. Registration is a read-modify-write of a file two
  // processes share, and a project vault is registered by whichever request
  // reaches it first — a scan and a WS hello arriving together can both decide
  // the entry is missing. Healing it on read costs nothing and beats showing
  // the same vault twice in the picker forever.
  const byId = new Map<string, VaultInfo>();
  for (const v of valid) if (!byId.has(v.id)) byId.set(v.id, v);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Project vaults
//
// Every project on this machine is already a directory of markdown — READMEs,
// design docs, a docs/ folder — and asking people to run `cast vault add` for
// each one is a step nobody would take. So the registry OFFERS them, and one is
// written to config.json the first time it is actually opened.
//
// Discovery lives here rather than in the HTTP layer on purpose: listVaults is
// what GET /vault/roots returns and findVault is what resolves the vault on
// every scan, read, write and watch. Teaching those two functions about project
// directories is enough for the entire surface — routes, watcher, mirror, CLI —
// to treat a project vault as the ordinary vault it becomes.
// ---------------------------------------------------------------------------

/** How long a discovery listing is reused. Discovery costs a readdir per
 *  project, so repeating it per request would be the expensive thing; a minute
 *  is far shorter than the rate at which people create projects. */
const DISCOVERY_TTL_MS = 60_000;

interface DiscoveryCacheEntry {
  vaults: VaultInfo[];
  at: number;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/** Drop the discovery cache — for tests, and for anything that changes what
 *  discovery would find (a removal, a hand registration). */
export function clearProjectVaultCache(): void {
  discoveryCache.clear();
}

/**
 * The home directory a config directory belongs to — `~/.codecast` → `~`.
 *
 * Discovery scans THIS, never `process.env.HOME`. A function handed an explicit
 * configDir must not reach past it into ambient machine state: that is what let
 * a test with a temp config directory list the developer's real projects. The
 * derivation is exact in production, where the config directory is literally
 * `$HOME/.codecast`, and a config kept somewhere unconventional simply
 * discovers nothing rather than discovering someone else's files.
 */
export function homeForConfigDir(configDir: string): string {
  return path.dirname(path.resolve(configDir));
}

function hiddenRoots(configDir: string): Set<string> {
  const raw = readConfig(configDir).vaults_hidden;
  return new Set(Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : []);
}

/**
 * Project directories worth offering as vaults: this machine's projects, minus
 * the ones already registered by hand, minus the ones the user removed, minus
 * the ones that cannot cheaply prove they hold any markdown at all.
 *
 * note_count is deliberately absent. The cheap probe sees the root and the doc
 * directory, so any count it produced would be a fraction of the truth — and a
 * vault claiming "3 notes" next to one holding two hundred is worse than one
 * claiming nothing. The real count arrives the first time the vault is scanned,
 * which is also when it becomes a persisted row that can hold the number.
 */
export function projectVaults(configDir: string): VaultInfo[] {
  const cached = discoveryCache.get(configDir);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.vaults;

  const taken = new Set(registeredVaults(configDir).map((v) => v.id));
  const hidden = hiddenRoots(configDir);
  const vaults: VaultInfo[] = [];
  for (const root of enumerateProjectRoots(homeForConfigDir(configDir))) {
    const id = vaultId(root);
    if (taken.has(id) || hidden.has(root)) continue;
    const probe = probeProjectVault(root);
    if (!probe.hasNotes) continue;
    vaults.push({
      id,
      root,
      name: path.basename(root) || root,
      added_at: 0,
      kind: "project",
      ...(probe.home ? { home: probe.home } : {}),
    });
  }
  vaults.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  discoveryCache.set(configDir, { vaults, at: Date.now() });
  return vaults;
}

/** Everything the vault surface offers: registered vaults first, then the
 *  machine's projects. This is what GET /vault/roots returns. */
export function listVaults(configDir: string): VaultInfo[] {
  return [...registeredVaults(configDir), ...projectVaults(configDir)];
}

/**
 * Look a vault up by id, or by absolute root path (what the CLI accepts).
 *
 * Resolving a project vault REGISTERS it. Every route that names a vault comes
 * through here, so the first scan, read or watch of a project directory is
 * exactly the moment it stops being a suggestion — from then on it is an
 * ordinary row in config.json that can hold a note count, a mirror flag and a
 * rename, and nothing downstream can tell it apart.
 */
export function findVault(configDir: string, idOrPath: string): VaultInfo | null {
  const resolved = path.resolve(idOrPath);
  const registered = registeredVaults(configDir);
  const hit =
    registered.find((v) => v.id === idOrPath) ??
    registered.find((v) => v.root === resolved || v.id === vaultId(resolved));
  if (hit) return hit;

  const discovered = projectVaults(configDir).find(
    (v) => v.id === idOrPath || v.root === resolved || v.id === vaultId(resolved),
  );
  if (!discovered) return null;
  return materializeProjectVault(configDir, discovered);
}

/** Write a discovered project vault into config.json. Returns the persisted
 *  entry, or the unpersisted one if the write failed — a vault that cannot be
 *  saved should still open. */
function materializeProjectVault(configDir: string, vault: VaultInfo): VaultInfo {
  const persisted: VaultInfo = { ...vault, added_at: Date.now() };
  try {
    const config = readConfig(configDir);
    const vaults = registeredVaults(configDir);
    // Another process may have registered it between the read above and here.
    const existing = vaults.find((v) => v.id === vault.id);
    if (existing) return existing;
    config.vaults = [...vaults, persisted];
    writeConfig(configDir, config);
    clearProjectVaultCache();
  } catch {
    return vault;
  }
  return persisted;
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
  const vaults = registeredVaults(configDir);
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
  // Adding a root by hand un-hides it: `cast vault add` is a clearer statement
  // of intent than whatever removal put it on the hidden list.
  config.vaults_hidden = [...hiddenRoots(configDir)].filter((r) => r !== root);
  writeConfig(configDir, config);
  clearProjectVaultCache();
  return vault;
}

/**
 * Unregister a vault by id or root path. Returns the removed entry, or null if
 * nothing matched. The directory itself is never touched.
 *
 * A project vault also goes on the hidden list. Dropping only its config row
 * would leave discovery free to re-offer it seconds later, which reads as the
 * removal having failed.
 */
export function removeVault(configDir: string, idOrPath: string): VaultInfo | null {
  const discovered = projectVaults(configDir).find(
    (v) => v.id === idOrPath || v.root === path.resolve(idOrPath),
  );
  const target = discovered ?? findVault(configDir, idOrPath);
  if (!target) return null;
  const config = readConfig(configDir);
  config.vaults = registeredVaults(configDir).filter((v) => v.id !== target.id);
  const hidden = hiddenRoots(configDir);
  hidden.add(target.root);
  config.vaults_hidden = [...hidden];
  writeConfig(configDir, config);
  clearProjectVaultCache();
  return target;
}

/** Turn the remote mirror on or off for one vault. Off by DEFAULT and off is a
 *  real off: the daemon tears the Convex projection down rather than leaving it
 *  stale (see vaultMirror.ts). Returns the updated vault, or null if unknown. */
export function setVaultMirroring(configDir: string, idOrPath: string, on: boolean): VaultInfo | null {
  const target = findVault(configDir, idOrPath);
  if (!target) return null;
  const vaults = registeredVaults(configDir);
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
  const vaults = registeredVaults(configDir);
  const vault = vaults.find((v) => v.id === id);
  if (!vault || vault.note_count === noteCount) return;
  vault.note_count = noteCount;
  const config = readConfig(configDir);
  config.vaults = vaults;
  writeConfig(configDir, config);
}
