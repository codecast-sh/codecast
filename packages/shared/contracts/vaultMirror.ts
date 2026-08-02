// Pure cross-runtime contract for the optional one-way Convex vault mirror.
// The local filesystem remains canonical; these limits bound only its remote
// read projection and are enforced by both the daemon and backend.

export const VAULT_MIRROR_MAX_BODY_BYTES = 64 * 1024;
export const VAULT_MIRROR_MAX_LINKS = 200;
export const VAULT_MIRROR_MAX_TAGS = 100;
export const VAULT_MIRROR_MAX_STAMP_BATCH = 500;

export interface VaultMirrorNote {
  path: string;
  title: string;
  mtime: number;
  size: number;
  content_hash: string;
  tags: string[];
  links: string[];
  heading_count: number;
  is_dir?: boolean;
  body_storage_id?: string;
}

export interface VaultMirrorUpsertRequest {
  device_id: string;
  vault_id: string;
  vault_name: string;
  notes: VaultMirrorNote[];
  deleted_paths?: string[];
  stamp_paths?: string[];
  scan_id?: string;
  complete?: boolean;
  sweep_after_path?: string;
  note_count?: number;
}

export interface VaultMirrorUpsertResponse {
  upserted: number;
  deleted: number;
  sweep_complete: boolean;
  sweep_after_path: string | null;
  note_count: number;
}
