// Vault remote mirror protocol — the contract between the daemon's pusher
// (packages/cli/src/vault/vaultMirror.ts), the Convex functions that store the
// mirror (packages/convex/convex/vaultMirror.ts), and the web reader.
//
// The mirror is a PROJECTION, never a source. The local filesystem stays
// canonical and the loopback bridge (vaultProtocol.ts) stays the primary
// channel; this tier exists only so a vault registered on one machine can be
// READ from another device. Mirroring is opt-in per vault and off by default —
// a registered vault must never silently upload itself.
//
// Note BODIES are never table rows. The docs table's 12-per-page clamp is scar
// tissue from Convex materializing whole bodies into a 64MB isolate heap before
// the handler can strip them; a vault would repeat that failure at a larger
// scale. Bodies ride ctx.storage and a row carries only a storage id.
//
// PURE isomorphic data — safe to import from the daemon, the Convex runtime,
// and the browser.

/** One note's metadata as the daemon pushes it. Everything here is cheap to
 *  materialize in bulk; nothing here grows with a note's length except `links`
 *  and `tags`, which the daemon caps. */
export interface VaultMirrorNote {
  /** Vault-relative, "/"-separated, exactly as the local scan reports it. */
  path: string;
  /** Frontmatter title > first H1 > basename. Resolved by the daemon so every
   *  reader shows the same name without fetching the body. */
  title: string;
  mtime: number;
  size: number;
  /** 16-hex sha256 prefix — the SAME digest the loopback GET /vault/file route
   *  serves as its ETag, so local and remote agree on "this is the same file". */
  content_hash: string;
  /** Tag names without the leading '#', frontmatter and inline merged. */
  tags: string[];
  /** Wiki-link targets as WRITTEN in the note (`[[Some Note#Heading]]` →
   *  "Some Note"). Resolution against the vault's name table is the reader's
   *  job — it needs the whole file list to do it, which the reader has. */
  links: string[];
  heading_count: number;
  /** Directories, so an empty folder still renders in a remote file tree. */
  is_dir?: boolean;
  /** Set when this push also uploaded the body for `content_hash`. */
  body_storage_id?: string;
}

/** One batch of a push. A full scan is split into many of these; the LAST batch
 *  of a scan sets `complete`, which is what licenses the server to delete rows
 *  the scan never touched. Incremental pushes carry no `scan_id` at all.
 *
 *  Authentication is NOT part of this shape: the transport attaches the api
 *  token, so the pusher builds payloads without holding a credential. */
export interface VaultMirrorUpsertRequest {
  device_id: string;
  vault_id: string;
  vault_name: string;
  notes: VaultMirrorNote[];
  /** Paths removed since the last push — targeted deletes from watcher events,
   *  independent of the full-scan sweep. */
  deleted_paths?: string[];
  /** Paths the scan saw UNCHANGED. Their rows need nothing but a fresh scan
   *  stamp so the completion sweep spares them, so they travel as bare strings
   *  instead of full metadata — which is what keeps a quiet vault's periodic
   *  scan from re-sending every note it already mirrored. */
  stamp_paths?: string[];
  /** Identifies the full scan these batches belong to. Every upserted row is
   *  stamped with it, so "absent from this scan" is a property the server can
   *  evaluate one row at a time instead of needing the whole path list. */
  scan_id?: string;
  /** Declares this the final batch of `scan_id`: sweep rows stamped with an
   *  older scan. The sweep walks the vault's rows in path order under a budget,
   *  so a large vault takes several calls (see `sweep_after_path`). */
  complete?: boolean;
  /** Resumes a budgeted sweep where the last call stopped. */
  sweep_after_path?: string;
  /** How many notes the scan counted. The daemon knows it exactly; deriving it
   *  server-side would mean walking every row of the vault on every batch. */
  note_count?: number;
}

export interface VaultMirrorUpsertResponse {
  upserted: number;
  deleted: number;
  /** False when a `complete` sweep hit its walk budget and stopped early: the
   *  daemon re-declares completion with `sweep_after_path` until this is true. */
  sweep_complete: boolean;
  /** Where to resume the sweep; null when it finished. */
  sweep_after_path: string | null;
  note_count: number;
}

/** POST /cli/vault/register — announces the vault itself before any notes. */
export interface VaultMirrorRegisterRequest {
  device_id: string;
  vault_id: string;
  name: string;
  root: string;
  /** Absent leaves the stored flag alone; false tears the mirror down. */
  enabled?: boolean;
}

/** A mirrored vault as the web reader sees it. */
export interface VaultMirrorSummary {
  vault_id: string;
  device_id: string;
  name: string;
  root: string;
  note_count: number;
  last_synced_at: number;
}

/** A mirrored note as the web reader sees it: the pushed metadata plus where
 *  the body can be fetched, when one has been uploaded. */
export interface VaultMirrorNoteRow extends VaultMirrorNote {
  vault_id: string;
  device_id: string;
  updated_at: number;
}

export interface VaultMirrorNoteBody {
  note: VaultMirrorNoteRow;
  /** Signed, expiring URL for the body blob; null when the body was never
   *  uploaded (too large for the size gate, or not yet requested). */
  body_url: string | null;
}

/** Bodies above this are pushed as metadata only. A note is prose: 64KB is a
 *  very long one, and the cap is what stops a stray dump file in a vault from
 *  turning a mirror sync into a bulk upload. */
export const VAULT_MIRROR_MAX_BODY_BYTES = 64 * 1024;

/** Per-note caps on the two unbounded metadata arrays. A note with 500 links is
 *  a generated index file; mirroring its full link list buys nothing and grows
 *  the row without bound. */
export const VAULT_MIRROR_MAX_LINKS = 200;
export const VAULT_MIRROR_MAX_TAGS = 100;

/** Paths per `stamp_paths` batch. Each one costs the server an index read, so
 *  this bounds the reads a single stamping mutation performs. */
export const VAULT_MIRROR_MAX_STAMP_BATCH = 500;
