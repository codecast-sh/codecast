// IndexedDB persistence for vault data. A small dedicated Dexie database —
// deliberately separate from the inboxStore cache: vault content is
// machine-local (served by this machine's daemon), doesn't flow through Convex
// sync, and has its own lifecycle (revalidated against /vault/scan on connect).
//
// Local-first boot: the store hydrates from here and paints before the daemon
// answers; the scan diff then patches whatever changed.

import Dexie, { type EntityTable } from "dexie";
import type { VaultFileEntry, VaultInfo } from "@codecast/shared/contracts";
import type { BookmarkItem } from "./bookmarks";

export interface VaultMetaRow {
  /** Vault id. */
  id: string;
  info: VaultInfo;
  files: VaultFileEntry[];
  scannedAt: number;
}

export interface VaultBodyRow {
  /** `${vaultId}:${path}` */
  key: string;
  vaultId: string;
  path: string;
  content: string;
  mtime: number;
  etag: string;
}

/** Per-vault UI state that must outlive a reload. Vault data is machine-local,
 *  so this belongs next to it rather than in Convex — a bookmark points at a
 *  path on THIS machine. */
export interface VaultPrefsRow {
  vaultId: string;
  bookmarks: BookmarkItem[];
}

const db = new Dexie("codecast-vault") as Dexie & {
  vault_meta: EntityTable<VaultMetaRow, "id">;
  vault_bodies: EntityTable<VaultBodyRow, "key">;
  vault_prefs: EntityTable<VaultPrefsRow, "vaultId">;
};

db.version(1).stores({
  vault_meta: "id",
  vault_bodies: "key, vaultId",
});

db.version(2).stores({
  vault_prefs: "vaultId",
});

export const bodyKey = (vaultId: string, path: string) => `${vaultId}:${path}`;

export async function loadVaultMeta(vaultId: string): Promise<VaultMetaRow | undefined> {
  try {
    return await db.vault_meta.get(vaultId);
  } catch {
    return undefined;
  }
}

export async function saveVaultMeta(row: VaultMetaRow): Promise<void> {
  try {
    await db.vault_meta.put(row);
  } catch {}
}

export async function loadVaultBodies(vaultId: string): Promise<VaultBodyRow[]> {
  try {
    return await db.vault_bodies.where("vaultId").equals(vaultId).toArray();
  } catch {
    return [];
  }
}

export async function saveVaultBodies(rows: VaultBodyRow[]): Promise<void> {
  if (!rows.length) return;
  try {
    await db.vault_bodies.bulkPut(rows);
  } catch {}
}

export async function deleteVaultBodies(vaultId: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await db.vault_bodies.bulkDelete(paths.map((p) => bodyKey(vaultId, p)));
  } catch {}
}

export async function loadVaultBookmarks(vaultId: string): Promise<BookmarkItem[]> {
  try {
    const row = await db.vault_prefs.get(vaultId);
    return Array.isArray(row?.bookmarks) ? row.bookmarks : [];
  } catch {
    return [];
  }
}

export async function saveVaultBookmarks(vaultId: string, bookmarks: BookmarkItem[]): Promise<void> {
  try {
    await db.vault_prefs.put({ vaultId, bookmarks });
  } catch {}
}

/** Drop everything for a vault (unregistered or root moved). */
export async function purgeVault(vaultId: string): Promise<void> {
  try {
    await db.vault_meta.delete(vaultId);
    await db.vault_bodies.where("vaultId").equals(vaultId).delete();
    await db.vault_prefs.delete(vaultId);
  } catch {}
}
