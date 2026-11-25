// Writing edits that came from outside the file's own editor (a project
// replace, a save of the results editor) back to files, the same way the
// editor saves (docs/architecture/code-editor.md, contract 4):
//
// - A file open in a buffer is edited in its EditorState, so the change is one
//   undo step there and nothing the buffer holds is lost. A clean buffer is
//   then saved through fileSync's compare-and-swap save (a 409 merges, exactly
//   as Cmd-S would); a dirty one keeps its unsaved state, now with the edit in
//   it, and disk is not touched.
// - A file not open is read, edited and written with If-Match on the version
//   read. A 409 is reported for that file and nothing is written.
//
// `compute` sees the file's text as it is right now and either returns the
// edits or refuses (the text no longer holds what the edits were planned
// against). Each file succeeds or fails whole: never half its edits.

import { readVaultFile, writeVaultFile, VaultWriteConflict } from "../../vault/client";
import { useVaultStore } from "../../../store/vaultStore";
import { bufferKey, codeBuffers, currentState, decodeFileText, fileFormatField, isDirty, type CodeBuffer, type DiskVersion } from "../buffers";
import { applyToBuffer, saveBuffer, type SaveOutcome } from "../fileSync";
import { applyEdits } from "./replace";

export type FileEdit = { from: number; to: number; insert: string };

export type ComputeEdits = (text: string) => FileEdit[] | { refuse: string };

export type FileEditStatus =
  /** Written to disk. */
  | "saved"
  /** Edited in an open buffer that already had unsaved changes; save it there. */
  | "unsaved"
  /** Disk moved since it was read: nothing written (a clean open buffer is
   *  now in its merge view instead). */
  | "conflict"
  /** The text no longer holds what the edits were planned against. */
  | "changed"
  /** Not writable here: a remote mirror, text that did not decode. */
  | "readonly"
  | "error";

export interface FileEditOutcome {
  path: string;
  status: FileEditStatus;
  detail?: string;
  /** The edits that landed, in the text they were computed on. */
  edits?: FileEdit[];
}

export interface WriteBackIO {
  buffer(path: string): CodeBuffer | undefined;
  read(path: string): Promise<DiskVersion | null>;
  /** Throws VaultWriteConflict when disk is not at `etag`. */
  write(path: string, content: string, etag: string): Promise<{ etag: string; mtime: number; size: number }>;
  adopt(path: string, disk: DiskVersion): void;
  save(buffer: CodeBuffer): Promise<SaveOutcome>;
}

/** Reads and writes in `vaultId` (the active vault when not given). Refuses
 *  when Files shows another vault now: edits planned in one checkout never land
 *  in a sibling worktree whose lines happen to match. */
export function vaultIO(vaultId?: string | null): WriteBackIO {
  const { endpoint, activeVaultId, isRemote, files } = useVaultStore.getState();
  if (!endpoint || !activeVaultId || isRemote) throw new Error("Files is not connected to this machine");
  if (vaultId !== undefined && vaultId !== activeVaultId) throw new Error("From another folder: open it in Files to save");
  return {
    buffer: (path) => codeBuffers.get(bufferKey(activeVaultId, path)),
    read: (path) => readVaultFile(endpoint, activeVaultId, path),
    write: (path, content, etag) =>
      writeVaultFile(endpoint, activeVaultId, path, content, etag, { ignored: !!files[path]?.ignored }),
    adopt: (path, disk) => useVaultStore.getState().adoptBody(activeVaultId, path, disk),
    save: (b) => saveBuffer(b),
  };
}

const BOM = "﻿";

async function editBuffer(b: CodeBuffer, compute: ComputeEdits, io: WriteBackIO): Promise<FileEditOutcome> {
  const state = currentState(b);
  if (state.readOnly || state.field(fileFormatField).lossy) return { path: b.path, status: "readonly" };
  if (b.merging) return { path: b.path, status: "conflict", detail: "Resolve its merge first" };
  const edits = compute(state.doc.toString());
  if (!Array.isArray(edits)) return { path: b.path, status: "changed", detail: edits.refuse };
  if (!edits.length) return { path: b.path, status: "saved", edits };
  const wasDirty = isDirty(state);
  applyToBuffer(b, { changes: edits, userEvent: "input.replace" });
  if (wasDirty) return { path: b.path, status: "unsaved", edits };
  const saved = await io.save(b);
  if (saved === "saved" || saved === "unchanged") return { path: b.path, status: "saved", edits };
  if (saved === "merging") return { path: b.path, status: "conflict", detail: "Changed on disk: merging", edits };
  // The edit is in the buffer either way: say so, so nobody retries it.
  return { path: b.path, status: "unsaved", detail: `Save failed (${saved}): edited in its tab`, edits };
}

async function editDisk(path: string, compute: ComputeEdits, io: WriteBackIO): Promise<FileEditOutcome> {
  const disk = await io.read(path);
  if (!disk) return { path, status: "error", detail: "Deleted on disk" };
  const { text, format } = decodeFileText(disk.content, disk.size);
  if (format.lossy) return { path, status: "readonly", detail: "Not UTF-8" };
  const edits = compute(text);
  if (!Array.isArray(edits)) return { path, status: "changed", detail: edits.refuse };
  if (!edits.length) return { path, status: "saved", edits };
  const content = (format.bom ? BOM : "") + applyEdits(text, edits);
  try {
    const res = await io.write(path, content, disk.etag);
    io.adopt(path, { content, etag: res.etag, mtime: res.mtime, size: res.size });
    return { path, status: "saved", edits };
  } catch (e) {
    if (e instanceof VaultWriteConflict) return { path, status: "conflict", detail: "Changed on disk" };
    return { path, status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Edit one file through its buffer when it is open, else on disk. */
export async function editFile(path: string, compute: ComputeEdits, io: WriteBackIO = vaultIO()): Promise<FileEditOutcome> {
  try {
    const b = io.buffer(path);
    return b ? await editBuffer(b, compute, io) : await editDisk(path, compute, io);
  } catch (e) {
    return { path, status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}

const CONCURRENCY = 6;

/** Edit many files of `vault` (an io, or the vault id to bind one to), a few
 *  at a time; outcomes in the order given. */
export async function editFiles(jobs: ReadonlyArray<{ path: string; compute: ComputeEdits }>, vault?: WriteBackIO | string | null): Promise<FileEditOutcome[]> {
  let resolved: WriteBackIO;
  try {
    resolved = vault && typeof vault === "object" ? vault : vaultIO(vault);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return jobs.map((j) => ({ path: j.path, status: "error" as const, detail }));
  }
  const out: FileEditOutcome[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await editFile(jobs[i].path, jobs[i].compute, resolved);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return out;
}
