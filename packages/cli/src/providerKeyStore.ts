// The on-device provider-key store: a standalone 0600 JSON file at
// ~/.codecast/provider-keys.json holding `{ providerId: apiKey }`.
//
// Kept OUT of config.json on purpose: config.json carries device-specific fields
// (auth_token, device_label, project mappings) that must not travel between
// machines, whereas the key store is a per-USER secret that syncs device→device
// over the credential-push channel — exactly like ~/.claude/.credentials.json, and
// pushable the same clean way (pipe over ssh into `cat > file`). The default is an
// absent file = nothing managed = clients use system auth.

import * as fs from "fs";
import * as path from "path";
import type { ProviderKeyStore } from "@codecast/shared/contracts";
import { atomicWriteFile } from "./atomicWrite.js";
import { readJsonForUpdate } from "./readForUpdate.js";

export const PROVIDER_KEY_STORE_FILE = "provider-keys.json";

export function providerKeyStorePath(configDir: string): string {
  return path.join(configDir, PROVIDER_KEY_STORE_FILE);
}

/** The managed keys on this device, or `{}` when nothing is managed (the default).
 *  Never throws — an unreadable/corrupt file reads as empty, so a bad file degrades
 *  to "use system auth" rather than breaking launches. */
export function readProviderKeyStore(configDir: string): ProviderKeyStore {
  try {
    const raw = fs.readFileSync(providerKeyStorePath(configDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ProviderKeyStore = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && v) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The managed keys, for a caller that is about to write them back.
 *
 * `readProviderKeyStore` above degrades an unreadable file to `{}` on purpose,
 * which is right for a launch: no managed keys means system auth, and no session
 * should die over this file. It is wrong for `cast keys set`, which adds one key
 * to what it read and writes the whole map back — there, a `{}` from a corrupt
 * read silently deletes every other provider's key, and the user only finds out
 * the next time a launch quietly falls back to system auth.
 *
 * So an update path reads through here instead: absent stays `{}`, and anything
 * else throws with the file named.
 */
export function readProviderKeyStoreForUpdate(configDir: string): ProviderKeyStore {
  const parsed = readJsonForUpdate<Record<string, unknown>>(
    providerKeyStorePath(configDir),
    (message) => new Error(message),
    (v) => typeof v === "object" && v !== null && !Array.isArray(v),
    "a provider key map",
  );
  const out: ProviderKeyStore = {};
  for (const [k, v] of Object.entries(parsed ?? {})) if (typeof v === "string" && v) out[k] = v;
  return out;
}

/** Write the store atomically at 0600, or remove the file when the store is empty
 *  (so "no managed keys" is a truly absent file, matching the default). Returns the
 *  serialized content actually on disk (or null when removed) — callers push that
 *  exact blob so a sync dedupes by content. */
export function writeProviderKeyStore(configDir: string, store: ProviderKeyStore): string | null {
  const file = providerKeyStorePath(configDir);
  const entries = Object.entries(store).filter(([, v]) => typeof v === "string" && v);
  if (entries.length === 0) {
    try { fs.rmSync(file, { force: true }); } catch {}
    return null;
  }
  // Sorted keys → deterministic content, so content-dedupe on push is stable.
  const obj: ProviderKeyStore = {};
  for (const [k] of entries.sort(([a], [b]) => a.localeCompare(b))) obj[k] = store[k];
  const content = JSON.stringify(obj, null, 2) + "\n";
  atomicWriteFile(file, content, { mode: 0o600 });
  return content;
}

/** Apply a store blob received from another device (Phase 2 push target): validate
 *  it parses to a string map, then write it. Returns true when a usable store was
 *  written. Used by the daemon when a peer pushes its keys in. */
export function applyProviderKeyStoreBlob(configDir: string, blob: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(blob); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const store: ProviderKeyStore = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string" && v) store[k] = v;
  }
  writeProviderKeyStore(configDir, store);
  return true;
}
