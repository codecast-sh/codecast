// The Files surface's per-browser preferences: the last vault, the vault list,
// panel and tree layout, and per-vault flags. All in localStorage rather than
// the IndexedDB cache, because each is read on the first render and an async
// read would paint the wrong state and then flip.

import type { VaultInfo } from "@codecast/shared/contracts";
import type { VaultState } from "./vaultTypes";

// Last-opened vault id, so the IDB cache can paint on a boot where the daemon
// is unreachable (discovery failing must not blank a vault we've already seen).
const LAST_VAULT_KEY = "cast_vault_last";

export function readLastVaultId(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

export function writeLastVaultId(id: string): void {
  try {
    localStorage.setItem(LAST_VAULT_KEY, id);
  } catch {}
}

// The vault LIST lives in localStorage rather than in the IndexedDB cache
// beside the file tables, and deliberately: the picker has to be populated on
// the very first render, and an IDB read — however fast — is a frame of empty
// list first. It matters more now that the list includes every project on the
// machine: discovering those costs the daemon a readdir per project, and first
// paint must never wait on that. The whole list is a few hundred short records.
const VAULT_LIST_KEY = "cast_vault_list";

export function readCachedVaults(): VaultInfo[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(VAULT_LIST_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is VaultInfo =>
        !!v && typeof v === "object" && typeof v.id === "string" && typeof v.root === "string",
    );
  } catch {
    return [];
  }
}

export function writeCachedVaults(vaults: VaultInfo[]): void {
  try {
    localStorage.setItem(VAULT_LIST_KEY, JSON.stringify(vaults));
  } catch {}
}

// "Show all files", per vault. localStorage and not the IDB prefs table for the
// same reason the vault list lives here: the tree paints on the first frame,
// and an async read would render the wrong file set and then flip.
export const SHOW_ALL_KEY = "cast_vault_show_all";

const RIGHT_PANEL_KEY = "vault.rightPanelOpen";

export function readRightPanelOpen(): boolean {
  try {
    return localStorage.getItem(RIGHT_PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeRightPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(RIGHT_PANEL_KEY, open ? "1" : "0");
  } catch {}
}

const TREE_LAYOUT_KEY = "vault.treeLayout";

/** Whether a full-tab Files page shows its tree, and how wide (px; null is
 *  the default share). A split-pane leaf keeps its own, unsaved. */
export interface TreeLayout {
  open: boolean;
  px: number | null;
}

export function readTreeLayout(): TreeLayout {
  try {
    const raw = JSON.parse(localStorage.getItem(TREE_LAYOUT_KEY) ?? "null") as Partial<TreeLayout> | null;
    if (raw && typeof raw === "object") return { open: raw.open !== false, px: typeof raw.px === "number" && raw.px > 0 ? Math.round(raw.px) : null };
  } catch {}
  return { open: true, px: null };
}

export function writeTreeLayout(patch: Partial<TreeLayout>): void {
  try {
    const next = { ...readTreeLayout(), ...patch };
    localStorage.setItem(TREE_LAYOUT_KEY, JSON.stringify(next));
  } catch {}
}

export const SHOW_IGNORED_KEY = "cast_vault_show_ignored";

/** A per-vault boolean the user set explicitly, or null when they never did. */
export function readVaultFlag(key: string, vaultId: string): boolean | null {
  try {
    const stored = localStorage.getItem(`${key}:${vaultId}`);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {}
  return null;
}

export function writeVaultFlag(key: string, vaultId: string, value: boolean): void {
  try {
    localStorage.setItem(`${key}:${vaultId}`, value ? "1" : "0");
  } catch {}
}

/**
 * Whether a vault opens showing everything on disk. The default follows what
 * the folder IS (a discovered project, or any git checkout once the scan says
 * so): a code project whose tree hides its own source is the wrong
 * first impression, and a notes folder full of dotfiles is too. An explicit
 * choice, once made, outranks both.
 */
export function readShowAllFiles(vaultId: string, vaults: VaultInfo[], isRepo = false): boolean {
  return readVaultFlag(SHOW_ALL_KEY, vaultId) ?? (isRepo || vaults.find((v) => v.id === vaultId)?.kind === "project");
}

/** What a cached boot knows of the root being a checkout, until the scan says. */
export function cachedRepo(vaultId: string, vaults: VaultInfo[], meta: { isRepo?: boolean }): Partial<Pick<VaultState, "isRepo" | "showAllFiles">> {
  return meta.isRepo ? { isRepo: true, showAllFiles: readShowAllFiles(vaultId, vaults, true) } : {};
}

export function readShowIgnoredFiles(vaultId: string): boolean {
  return readVaultFlag(SHOW_IGNORED_KEY, vaultId) ?? false;
}
