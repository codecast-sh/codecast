// Collaborative-doc snapshot storage codec.
//
// A snapshot is the entire ProseMirror document serialized as a JSON string.
// For a large doc that JSON easily exceeds Convex's 1 MiB per-document limit, so
// we gzip it before storing (ProseMirror JSON is highly repetitive text and
// compresses ~5-10x) and decompress on read. Rows written before compression
// existed still carry the raw string in `content`; readSnapshotContent handles
// both forms, so no data migration is needed. Pure (no Convex runtime) — the
// codec is unit-tested directly.
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";

export type SnapshotRow = { content?: string | null; content_gz?: ArrayBuffer | null };

export function packSnapshotContent(json: string): ArrayBuffer {
  const u8 = gzipSync(strToU8(json), { level: 6 });
  // Copy into a fresh ArrayBuffer: fflate's output may be a view, and Convex's
  // bytes validator wants a plain (non-shared) ArrayBuffer.
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return buf;
}

export function readSnapshotContent(row: SnapshotRow): string {
  if (row.content_gz) return strFromU8(gunzipSync(new Uint8Array(row.content_gz)));
  return row.content ?? "";
}
