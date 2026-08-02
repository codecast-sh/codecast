// Reading a vault mirrored from ANOTHER machine.
//
// The local path (daemon loopback) is canonical and always preferred. This is
// the fallback for a vault whose machine isn't this one: metadata comes from
// the vault_notes rows the owning daemon pushed, and a note's body arrives as a
// signed storage URL — fetched on demand, never held for the whole vault.
//
// Everything here is READ-ONLY by construction. There is no write path: edits
// belong to the machine that owns the files.

import type { ConvexReactClient } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { VaultFileEntry, VaultInfo } from "@codecast/shared/contracts";

export interface RemoteVault extends VaultInfo {
  device_id: string;
  last_synced_at: number;
  /** Always true — the surface uses this to hide every write affordance. */
  remote: true;
}

export interface RemoteNoteMeta {
  path: string;
  title: string;
  mtime: number;
  size: number;
  content_hash: string;
  tags: string[];
  links: string[];
  heading_count: number;
  is_dir?: boolean;
  /** False when the body was never uploaded (too large, or not yet requested). */
  has_body: boolean;
}

const NOTES_PAGE = 100;

export async function listRemoteVaults(convex: ConvexReactClient): Promise<RemoteVault[]> {
  const rows = await convex.query(api.vaultMirror.webListVaults, {});
  return rows.map((r) => ({
    id: r.vault_id,
    root: r.root,
    name: r.name,
    note_count: r.note_count,
    added_at: r.last_synced_at,
    device_id: r.device_id,
    last_synced_at: r.last_synced_at,
    remote: true as const,
  }));
}

/** Page through every mirrored note's metadata. The server caps the page size;
 *  paging here rather than asking for everything keeps each query inside the
 *  isolate's memory budget — the same constraint that keeps bodies out of rows. */
export async function fetchRemoteNotes(
  convex: ConvexReactClient,
  vaultId: string,
  deviceId?: string,
): Promise<RemoteNoteMeta[]> {
  const out: RemoteNoteMeta[] = [];
  let after: string | undefined;
  // Bounded: a vault beyond this is pathological, and an unbounded loop against
  // a paging cursor is how a bad cursor becomes an infinite request storm.
  for (let page = 0; page < 200; page++) {
    const res = await convex.query(api.vaultMirror.webListNotes, {
      vault_id: vaultId,
      device_id: deviceId,
      after_path: after,
      limit: NOTES_PAGE,
    });
    // The server strips body_storage_id from the row but keeps its presence in
    // `has_body`; map defensively rather than casting, so a schema drift shows
    // up here as a missing flag instead of a lie about what's fetchable.
    const rows = (res?.notes ?? []) as Array<Omit<RemoteNoteMeta, "has_body"> & { has_body?: boolean }>;
    const notes: RemoteNoteMeta[] = rows.map((r) => ({ ...r, has_body: r.has_body ?? false }));
    out.push(...notes);
    if (notes.length < NOTES_PAGE) break;
    after = notes[notes.length - 1]?.path;
    if (!after) break;
  }
  return out;
}

/** A note's body, or null when the owning machine never uploaded one. */
export async function fetchRemoteBody(
  convex: ConvexReactClient,
  vaultId: string,
  path: string,
  deviceId?: string,
): Promise<{ content: string | null; reason?: "not-uploaded" | "unreachable" }> {
  const res = await convex.query(api.vaultMirror.webGetNote, {
    vault_id: vaultId,
    path,
    device_id: deviceId,
  });
  const url = (res as { body_url?: string | null })?.body_url ?? null;
  if (!url) return { content: null, reason: "not-uploaded" };
  try {
    const r = await fetch(url);
    if (!r.ok) return { content: null, reason: "unreachable" };
    return { content: await r.text() };
  } catch {
    return { content: null, reason: "unreachable" };
  }
}

/** Mirror metadata in the shape the explorer already renders, so a remote vault
 *  reuses the local tree, search index, and link resolution unchanged. */
export function remoteNotesToFileTable(notes: RemoteNoteMeta[]): Record<string, VaultFileEntry> {
  const files: Record<string, VaultFileEntry> = {};
  for (const n of notes) {
    files[n.path] = { path: n.path, mtime: n.mtime, size: n.size, dir: n.is_dir };
  }
  return files;
}
