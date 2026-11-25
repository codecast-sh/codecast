// The disk side of a buffer: saving, reverting, taking in a change someone else
// made, and reconciling the two when both wrote (docs/architecture/code-editor.md,
// contract 4).
//
// Every write is compare-and-swap on the buffer's own base etag. A 409 never
// overwrites: a clean buffer adopts disk, a dirty one merges three ways (base,
// disk, mine). Changes only one side made land by themselves, as in git; only
// a region both sides changed differently opens the merge view, where each
// chunk is kept or taken and the save writes the result.
//
// A change on disk while the buffer is clean lands as the smallest line edits,
// annotated `externalChange` so features (agent highlights) can color exactly
// what moved. While the buffer is dirty it waits, marked stale, for the save.

import { Annotation, Compartment, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readVaultFile, vaultOp, writeVaultFile, VaultWriteConflict } from "../vault/client";
import { setCodeBodyHolder, useVaultStore } from "../../store/vaultStore";
import { useCodeStore } from "../../store/codeStore";
import {
  bufferKey,
  codeBuffers,
  currentState,
  decodeFileText,
  encodeFileText,
  fileFormatField,
  isDirty,
  savedDocField,
  setFileFormat,
  setSavedDoc,
  textToDoc,
  updateBuffer,
  utf8Length,
  type CodeBuffer,
  type DiskVersion,
} from "./buffers";
import { featureContext, LARGE_FILE_BYTES } from "./features";
import { clearHotExit, flushHotExit, loadHotExit, scheduleHotExit, type HotExitDraft } from "./hotExit";
import { clearNewFile, isNewFile } from "./newFiles";
import { lineChanges, loadMergeKit, mergeChunkCount, mergeViewExtension, threeWayMerge, type MergeKit } from "./merge";

/** Marks a transaction that brought in a version someone else wrote. */
export const externalChange = Annotation.define<{ etag: string }>();

/** Holds the merge view while a buffer is merging. */
const mergeSlot = new Compartment();

type Written = { etag: string; mtime: number; size: number };

export interface DiskIO {
  /** Throws VaultWriteConflict when disk is no longer at `baseEtag`. */
  write(buffer: CodeBuffer, content: string, baseEtag: string): Promise<Written>;
  /** Create the file empty; refused (throws) when it already exists. */
  createEmpty(buffer: CodeBuffer): Promise<void>;
  read(buffer: CodeBuffer): Promise<DiskVersion | null>;
  /** Tell the rest of the app what disk now holds (vaultStore's body). */
  adopt(buffer: CodeBuffer, disk: DiskVersion): void;
}

function connectedEndpoint() {
  const { endpoint } = useVaultStore.getState();
  if (!endpoint) throw new Error("Files is not connected to this machine");
  return endpoint;
}

/** A file the tree lists as ignored (a gitignored `.env`, a build output) is
 *  written only with the daemon's opt-in; the never-writable set stays refused. */
function writeOptions(b: CodeBuffer) {
  const { activeVaultId, files } = useVaultStore.getState();
  return { ignored: activeVaultId === b.vaultId && !!files[b.path]?.ignored };
}

const vaultIO: DiskIO = {
  write: (b, content, baseEtag) => {
    // An empty etag would turn into a PUT without If-Match: an overwrite.
    if (!baseEtag) throw new Error("No disk version to save over");
    return writeVaultFile(connectedEndpoint(), b.vaultId, b.path, content, baseEtag, writeOptions(b));
  },
  createEmpty: async (b) => {
    await vaultOp(connectedEndpoint(), b.vaultId, { op: "create", path: b.path, content: "" }, writeOptions(b));
  },
  read: (b) => readVaultFile(connectedEndpoint(), b.vaultId, b.path),
  adopt: (b, disk) => useVaultStore.getState().adoptBody(b.vaultId, b.path, disk),
};

let io: DiskIO = vaultIO;

// A file that leaves disk and returns comes back into any editor still open on it.
setCodeBodyHolder((vaultId, path) => !!codeBuffers.get(bufferKey(vaultId, path)));

/** Tests: swap the disk. Returns the restore. */
export function _setDiskIOForTests(next: DiskIO): () => void {
  io = next;
  return () => {
    io = vaultIO;
  };
}

const chrome = () => useCodeStore.getState();

function bufferOf(state: EditorView["state"]): CodeBuffer | undefined {
  const ctx = state.facet(featureContext);
  return ctx ? codeBuffers.get(bufferKey(ctx.vaultId, ctx.path)) : undefined;
}

function hotExitDraft(b: CodeBuffer): HotExitDraft | null {
  const state = currentState(b);
  if (!isDirty(state)) return null;
  return {
    key: b.key,
    vaultId: b.vaultId,
    path: b.path,
    mine: encodeFileText(state),
    base: () => encodeFileText(state, state.field(savedDocField)),
    baseEtag: b.baseEtag,
    savedAt: Date.now(),
  };
}

/** After any transaction: flip chrome on a clean/dirty transition only, and
 *  hold unsaved text for hot exit once typing pauses. This runs per keystroke,
 *  so it costs a `Text.eq`, a map lookup and a timer reset, and writes no store
 *  unless something a person sees changed. */
function noteChange(b: CodeBuffer, docChanged: boolean): void {
  const state = currentState(b);
  const dirty = isDirty(state);
  if (dirty !== b.dirty) {
    b.dirty = dirty;
    chrome().setDirty(b.key, dirty);
    if (!dirty) {
      void clearHotExit(b.key);
      // A failed save of text that is no longer there is not news.
      if (useCodeStore.getState().conflicts[b.key]?.kind === "error") chrome().setConflict(b.key, null);
    }
  }
  // A large file's text is megabytes to encode and clone: hold it less often.
  if (dirty && docChanged) scheduleHotExit(b.key, () => hotExitDraft(b), b.sizeBytes > LARGE_FILE_BYTES ? 5000 : undefined);
  // A chunk's "Keep mine" moves the merge's original, not the document.
  if (b.merging) void refreshMergeCount(b);
}

/** Extensions every buffer's state carries. */
export function fileSyncExtensions(): Extension {
  return [
    mergeSlot.of([]),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged && !u.transactions.some((tr) => tr.effects.length)) return;
      const b = bufferOf(u.state);
      if (b && b.view === u.view) noteChange(b, u.docChanged);
    }),
  ];
}

/** A transaction on a buffer from outside the editor; an off-screen buffer
 *  has no listener, so its bookkeeping runs here. */
export function applyToBuffer(b: CodeBuffer, spec: TransactionSpec): void {
  const before = currentState(b).doc;
  updateBuffer(b, spec);
  if (!b.view) noteChange(b, currentState(b).doc !== before);
}

/** Mark the current document as what disk holds at `etag`. */
function markSaved(b: CodeBuffer, etag: string): void {
  clearNewFile(b.key);
  b.baseEtag = etag;
  b.stale = null;
  applyToBuffer(b, { effects: setSavedDoc.of(currentState(b).doc) });
}

/** Replace the buffer's text with a disk version in the fewest line edits,
 *  keeping cursor and folds where the text around them did not move. */
function adopt(b: CodeBuffer, disk: DiskVersion, kit: MergeKit | null): void {
  const { text, format: decoded } = decodeFileText(disk.content, disk.size);
  // Without the served size a dropped BOM or a masked byte cannot be seen, so
  // the file keeps what was known of it.
  const known = currentState(b).field(fileFormatField);
  const format = disk.size === undefined ? { ...decoded, bom: decoded.bom || known.bom, lossy: known.lossy } : decoded;
  const from = currentState(b).doc.toString();
  const to = textToDoc(text).toString();
  const changes = kit ? lineChanges(kit, from, to) : [{ from: 0, to: from.length, insert: to }];
  applyToBuffer(b, {
    changes,
    effects: [setFileFormat.of(format), mergeSlot.reconfigure([])],
    annotations: externalChange.of({ etag: disk.etag }),
  });
  b.merging = null;
  markSaved(b, disk.etag);
  chrome().setConflict(b.key, null);
  void clearHotExit(b.key);
}

/** Disk holds the text this buffer was opened at (or last saved). */
function isBaseVersion(b: CodeBuffer, disk: DiskVersion): boolean {
  if (disk.etag) return disk.etag === b.baseEtag;
  const state = currentState(b);
  return encodeFileText(state, state.field(savedDocField)) === disk.content;
}

/** Someone else wrote the file. A clean buffer takes it in; a dirty one waits
 *  for its save; a merging one already has a newer question to answer. */
export async function applyDiskVersion(b: CodeBuffer, disk: DiskVersion): Promise<void> {
  // A version on disk means the file is back, whatever it holds.
  if (chrome().conflicts[b.key]?.kind === "deleted") chrome().setConflict(b.key, null);
  if (isBaseVersion(b, disk) || b.merging) return;
  const before = currentState(b);
  if (isDirty(before)) {
    b.stale = disk;
    chrome().setConflict(b.key, { kind: "stale" });
    return;
  }
  const kit = await loadMergeKit().catch(() => null);
  // Typing while the diff code loaded: decide again on the text as it is now.
  if (currentState(b).doc !== before.doc) return applyDiskVersion(b, disk);
  if (isBaseVersion(b, disk) || b.merging) return;
  adopt(b, disk, kit);
}

/** The file left disk. Unsaved edits wait for a Recreate. A clean buffer has
 *  nothing to lose and says nothing, unless it stays on screen (evenIfClean),
 *  where a save would otherwise quietly write nothing. */
export function diskRemoved(b: CodeBuffer, opts: { evenIfClean?: boolean } = {}): void {
  if (b.merging || isNewFile(b.key)) return;
  if (opts.evenIfClean || isDirty(currentState(b))) chrome().setConflict(b.key, { kind: "deleted" });
}

/** Rebase the buffer onto a disk version, keeping its text: what was disk's
 *  side of a merge becomes the saved version, and the buffer is dirty by
 *  exactly the lines it keeps. */
function rebaseOnto(b: CodeBuffer, disk: DiskVersion): void {
  // A disk version to build on: whatever was new now exists.
  clearNewFile(b.key);
  b.baseEtag = disk.etag;
  b.stale = null;
  b.merging = null;
  applyToBuffer(b, { effects: [mergeSlot.reconfigure([]), setSavedDoc.of(textToDoc(disk.content))] });
  chrome().setConflict(b.key, null);
}

async function refreshMergeCount(b: CodeBuffer): Promise<void> {
  const kit = await loadMergeKit();
  const current = useCodeStore.getState().conflicts[b.key];
  if (!b.merging || current?.kind !== "merge") return;
  chrome().setConflict(b.key, { ...current, remaining: mergeChunkCount(kit, currentState(b)) });
}

/**
 * Three-way merge the buffer with a disk version, its saved text as the base.
 * Without a conflict the merged text simply becomes the buffer, rebased onto
 * disk ("merged"); with one, the editor turns into a merge view ("merging").
 */
export async function mergeWithDisk(b: CodeBuffer, disk: DiskVersion): Promise<"merged" | "merging"> {
  clearNewFile(b.key);
  const kit = await loadMergeKit();
  const state = currentState(b);
  const base = state.field(savedDocField).toString();
  const diskText = textToDoc(disk.content).toString();
  const mine = state.doc.toString();
  const result = threeWayMerge(kit, base, diskText, mine);
  const changes = lineChanges(kit, mine, result.text);
  if (result.conflicts === 0) {
    applyToBuffer(b, { changes, userEvent: "merge" });
    rebaseOnto(b, disk);
    return "merged";
  }
  b.stale = null;
  b.merging = disk;
  applyToBuffer(b, { changes, userEvent: "merge", effects: mergeSlot.reconfigure(mergeViewExtension(kit, diskText)) });
  chrome().setConflict(b.key, {
    kind: "merge",
    remaining: mergeChunkCount(kit, currentState(b)),
    conflicts: result.conflicts,
  });
  return "merging";
}

export type SaveOutcome = "unchanged" | "saved" | "merging" | "adopted" | "deleted" | "readonly" | "error";

const inflight = new Map<string, Promise<SaveOutcome>>();

/** Vaults whose buffers are not vault files and save some other way (the
 *  vimrc overlay on Settings > Editor writes through the daemon's overlay
 *  route). Save, Save all and autosave all reach it through saveBuffer. */
const vaultSavers = new Map<string, (b: CodeBuffer) => Promise<SaveOutcome>>();

/** The vault's buffers save some other way: they are not vault files. */
export function hasVaultSaver(vaultId: string): boolean {
  return vaultSavers.has(vaultId);
}

export function registerVaultSaver(vaultId: string, save: (b: CodeBuffer) => Promise<SaveOutcome>): () => void {
  vaultSavers.set(vaultId, save);
  return () => {
    if (vaultSavers.get(vaultId) === save) vaultSavers.delete(vaultId);
  };
}

/** Buffers whose unsaved edits are being thrown away (revert, take disk's
 *  version): nothing may write them until disk's text has landed. */
const discarding = new Set<string>();

export function discardInFlight(b: CodeBuffer): boolean {
  return discarding.has(b.key);
}

async function discard(b: CodeBuffer, run: () => Promise<void>): Promise<void> {
  discarding.add(b.key);
  try {
    await run();
  } finally {
    discarding.delete(b.key);
  }
}

/** Save a buffer. Saves of one buffer queue behind each other, so a second
 *  Cmd-S during a slow write writes again only if there is something new. */
export function saveBuffer(b: CodeBuffer, opts: { recreate?: boolean } = {}): Promise<SaveOutcome> {
  const custom = vaultSavers.get(b.vaultId);
  const run = (inflight.get(b.key) ?? Promise.resolve("unchanged" as SaveOutcome)).then(() => (custom ? custom(b) : writeBuffer(b, !!opts.recreate)));
  inflight.set(b.key, run);
  void run.finally(() => {
    if (inflight.get(b.key) === run) inflight.delete(b.key);
  });
  return run;
}

/** Save every unsaved buffer (Save all, `:wa`). A buffer in an unresolved
 *  merge is left alone: saving it accepts every chunk as the editor shows it,
 *  which is a choice the person makes in its merge view, never in bulk for a
 *  file they have not looked at. */
export function saveAllBuffers(): Promise<SaveOutcome[]> {
  return Promise.all(codeBuffers.dirty().filter((b) => !b.merging).map((b) => saveBuffer(b)));
}

/** Write the file again after it was deleted on disk, from the buffer's text. */
export function recreateFile(b: CodeBuffer): Promise<SaveOutcome> {
  return saveBuffer(b, { recreate: true });
}

async function writeBuffer(b: CodeBuffer, recreate: boolean): Promise<SaveOutcome> {
  const start = currentState(b);
  if (start.readOnly || start.field(fileFormatField).lossy) return "readonly";
  // A new file (`:e newfile.ts`) is created on its first save, empty or not,
  // folders and all; it never writes over a file that appeared meanwhile.
  if (recreate || isNewFile(b.key)) return writeOut(b, (content) => recreateWrite(b, content));
  // Saving while merging accepts what the editor shows: the merged text,
  // on top of the disk version it was merged with.
  if (b.merging) rebaseOnto(b, b.merging);
  if (!isDirty(currentState(b))) {
    if (!b.stale) return "unchanged";
    adopt(b, b.stale, await loadMergeKit().catch(() => null));
    return "adopted";
  }
  if (b.stale) {
    const merged = await mergeWithDisk(b, b.stale);
    if (merged === "merging") return "merging";
  }
  const base = b.baseEtag;
  return writeOut(b, (content) => io.write(b, content, base));
}

/** Write a file deleted on disk back, never over a file that has returned.
 *  The daemon's create op refuses an existing path under its path lock, but its
 *  JSON body is capped (256 KB), so it only claims the path, empty, and the
 *  bytes follow through the guarded PUT on the etag read back. An empty file
 *  holds nothing to lose, which also lets a Recreate whose PUT failed run again;
 *  anything else there is a version to reconcile with. */
async function recreateWrite(b: CodeBuffer, content: string): Promise<Written> {
  let refused: unknown = null;
  await io.createEmpty(b).catch((e) => {
    refused = e;
  });
  const disk = await io.read(b).catch(() => null);
  if (!disk) throw refused ?? new Error("The file vanished while being recreated");
  if (disk.content !== "") throw new VaultWriteConflict({ ...disk, size: disk.size ?? utf8Length(disk.content) });
  return io.write(b, content, disk.etag);
}

async function writeOut(b: CodeBuffer, write: (content: string) => Promise<Written>): Promise<SaveOutcome> {
  const state = currentState(b);
  const doc = state.doc;
  const content = encodeFileText(state);
  let res: Written;
  try {
    res = await write(content);
  } catch (e) {
    if (e instanceof VaultWriteConflict) {
      // No etag is the daemon saying the file is gone: its body is an error
      // message, not a version to merge with.
      if (!e.current.etag) {
        chrome().setConflict(b.key, { kind: "deleted" });
        return "deleted";
      }
      const disk: DiskVersion = { content: e.current.content, etag: e.current.etag, mtime: e.current.mtime, size: e.current.size };
      if (!isDirty(currentState(b))) {
        adopt(b, disk, await loadMergeKit().catch(() => null));
        return "adopted";
      }
      const merged = await mergeWithDisk(b, disk);
      return merged === "merging" ? "merging" : writeBuffer(b, false);
    }
    chrome().setConflict(b.key, { kind: "error", message: e instanceof Error ? e.message : String(e) });
    return "error";
  }
  // The text written is the saved version, even if typing continued meanwhile.
  b.baseEtag = res.etag;
  b.stale = null;
  applyToBuffer(b, { effects: setSavedDoc.of(doc) });
  chrome().setConflict(b.key, null);
  clearNewFile(b.key);
  io.adopt(b, { content, etag: res.etag, mtime: res.mtime, size: res.size });
  return "saved";
}

/** Take disk's version wholesale, ending a merge or discarding unsaved edits. */
export function takeDisk(b: CodeBuffer): Promise<void> {
  return discard(b, async () => {
    const disk = b.merging ?? b.stale ?? (await io.read(b));
    if (!disk) return;
    adopt(b, disk, await loadMergeKit().catch(() => null));
  });
}

/** Reload from disk, dropping unsaved edits (undo brings them back). */
export function revertBuffer(b: CodeBuffer): Promise<void> {
  return discard(b, async () => {
    const disk = await io.read(b).catch(() => null);
    if (!disk) return;
    adopt(b, disk, await loadMergeKit().catch(() => null));
    io.adopt(b, disk);
  });
}

/**
 * Bring back the unsaved text a reload or crash interrupted. Disk at the same
 * version: the text simply returns, dirty. Disk moved meanwhile: the held text
 * is merged with it, the held base as the merge base.
 */
export async function restoreHotExit(b: CodeBuffer): Promise<"none" | "restored" | "merging"> {
  const rec = await loadHotExit(b.key);
  if (!rec) return "none";
  const kit = await loadMergeKit();
  // Read the state only now: the person may have typed while the record and
  // the diff code loaded, and their typing wins over the held text.
  const state = currentState(b);
  if (isDirty(state) || b.merging) return "none";
  if (rec.mine === encodeFileText(state)) {
    await clearHotExit(b.key);
    return "none";
  }
  const disk: DiskVersion = { content: encodeFileText(state), etag: b.baseEtag, mtime: 0 };
  const sameBase = rec.baseEtag === b.baseEtag;
  const mine = decodeFileText(rec.mine).text;
  applyToBuffer(b, { changes: lineChanges(kit, state.doc.toString(), textToDoc(mine).toString()), userEvent: "restore" });
  if (sameBase) return "restored";
  b.baseEtag = rec.baseEtag;
  applyToBuffer(b, { effects: setSavedDoc.of(textToDoc(rec.base)) });
  return (await mergeWithDisk(b, disk)) === "merging" ? "merging" : "restored";
}

let guarded = false;
/** Unsaved edits that live outside codeBuffers (the search results editor). */
const unsavedElsewhere = new Set<() => boolean>();

/** Count edits held outside codeBuffers in the close guard. */
export function registerUnsavedCheck(check: () => boolean): () => void {
  unsavedElsewhere.add(check);
  return () => unsavedElsewhere.delete(check);
}

/** Whether anything would be lost if the page closed now. */
export function hasUnsavedEdits(): boolean {
  return codeBuffers.dirty().length > 0 || [...unsavedElsewhere].some((check) => check());
}

/** Warn before the page closes with unsaved buffers, and hold their text for
 *  hot exit either way. */
export function installCloseGuard(): void {
  if (guarded || typeof window === "undefined") return;
  guarded = true;
  window.addEventListener("pagehide", () => void flushHotExit());
  window.addEventListener("beforeunload", (e) => {
    void flushHotExit();
    if (!hasUnsavedEdits()) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
