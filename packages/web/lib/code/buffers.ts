// Open buffers: one per file a person has opened, holding everything that makes
// coming back to a file feel like it never left. The editor's document, undo
// history, selection and folds all live in the buffer's CodeMirror
// EditorState, so switching files is `view.setState(buffer.state)` plus a
// scroll restore, never a remount (docs/architecture/code-editor.md, contract 2).
//
// What disk holds lives INSIDE the state too: `savedDocField` is the text of
// the version the buffer is editing on top of, and `fileFormatField` how that
// file is stored (line separator, byte order mark). So "is this buffer dirty"
// is a question the state answers by itself, and `Text.eq` answers it from
// shared tree structure in a few comparisons rather than by rereading the file
// on every keystroke. The one disk fact outside the state is `baseEtag`, the
// buffer's half of every compare-and-swap write, which only ever moves
// together with the saved document (fileSync.ts).
//
// No React, no store, no network: fileSync.ts and the editor component drive
// this, and tests drive it directly.

import { EditorState, StateEffect, StateField, Text, type Extension, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { detectLineSeparator } from "../vault/editorDoc";
import { bufferKey } from "../../store/codeStore";

export type LineSeparator = "\n" | "\r\n";

/** How the file is stored on disk, carried back out at write time. */
export interface FileFormat {
  lineSeparator: LineSeparator;
  bom: boolean;
  /** The bytes did not decode as UTF-8 (a Latin-1 or Windows-1252 file): the
   *  text holds U+FFFD where they were, so writing it back would destroy them.
   *  Such a buffer opens read-only. */
  lossy: boolean;
}

export const setFileFormat = StateEffect.define<FileFormat>();

export const fileFormatField = StateField.define<FileFormat>({
  create: () => ({ lineSeparator: "\n", bom: false, lossy: false }),
  update: (format, tr) => {
    for (const e of tr.effects) if (e.is(setFileFormat)) return e.value;
    return format;
  },
});

/** Mark a document as what disk holds. */
export const setSavedDoc = StateEffect.define<Text>();

export const savedDocField = StateField.define<Text>({
  create: (state) => state.doc,
  update: (saved, tr) => {
    for (const e of tr.effects) if (e.is(setSavedDoc)) return e.value;
    return saved;
  },
});

export function isDirty(state: EditorState): boolean {
  return !state.doc.eq(state.field(savedDocField));
}

const BOM = "\uFEFF";
const REPLACEMENT = "\uFFFD";

/** UTF-8 byte length of a string, without allocating its encoding. */
export function utf8Length(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      n += 2; // a surrogate pair: 2 UTF-16 units, 4 bytes
      i++;
    } else n += 2;
  }
  return n;
}

/** File text as CodeMirror will hold it. CodeMirror splits lines on any of
 *  \n, \r\n and \r but always joins with "\n", so the file's own separator is
 *  detected (majority wins for a mixed file) and carried to the write. A byte
 *  order mark stays off the document, where it would be an invisible first
 *  character, and is written back.
 *
 *  `sizeBytes` is the byte count served with `content`, never a size read
 *  separately, which may describe another version. The browser's UTF-8
 *  decode drops a leading BOM and turns undecodable bytes into U+FFFD without
 *  a word, so the size is how either is noticed: three bytes more than the text is a BOM, and
 *  a U+FFFD the size does not account for is a file in another encoding. */
export function decodeFileText(content: string, sizeBytes?: number): { text: string; format: FileFormat } {
  let bom = content.startsWith(BOM);
  const text = bom ? content.slice(1) : content;
  const replaced = text.includes(REPLACEMENT);
  let lossy = replaced && sizeBytes === undefined;
  // Without a U+FFFD, a size equal to the length is plain ASCII: nothing to infer.
  if (sizeBytes !== undefined && (replaced || sizeBytes !== text.length)) {
    const bytes = utf8Length(text);
    if (bytes + 3 === sizeBytes) bom = true;
    lossy = replaced && bytes !== sizeBytes && bytes + 3 !== sizeBytes;
  }
  return { text, format: { lineSeparator: detectLineSeparator(text), bom, lossy } };
}

/** The buffer's document back to file bytes. */
export function encodeFileText(state: EditorState, doc: Text = state.doc): string {
  const { lineSeparator, bom } = state.field(fileFormatField);
  const text = doc.sliceString(0, doc.length, lineSeparator);
  return bom ? BOM + text : text;
}

/** A file's text as a document, normalized the way the editor holds it. */
export function textToDoc(content: string): Text {
  return Text.of(decodeFileText(content).text.split(/\r\n|\r|\n/));
}

/** A disk version this buffer has not taken in. */
export interface DiskVersion {
  content: string;
  etag: string;
  mtime: number;
  size?: number;
  /** The mode, when it refuses writes (VaultFileContent.lockedMode). */
  lockedMode?: string;
}

export interface CodeBuffer {
  readonly key: string;
  readonly vaultId: string;
  readonly path: string;
  /** The state while off screen. While `view` is set the view holds the live
   *  state and this is refreshed when the buffer leaves it. */
  state: EditorState;
  view: EditorView | null;
  /** Where the buffer was scrolled when it left the screen
   *  (EditorView.scrollSnapshot), dispatched again when it returns. */
  scroll: StateEffect<unknown> | null;
  baseEtag: string;
  /** Last known isDirty(state). Changes only on transitions, which is what
   *  chrome (the dirty dot, the close guard) follows. */
  dirty: boolean;
  /** Disk moved while this buffer was dirty (an agent wrote the file under an
   *  edit). Resolved at the next save through the three-way merge. */
  stale: DiskVersion | null;
  /** Set while the editor is showing a merge against this disk version. */
  merging: DiskVersion | null;
  sizeBytes: number;
  lastUsed: number;
}

export { bufferKey };

export function currentState(buffer: CodeBuffer): EditorState {
  return buffer.view?.state ?? buffer.state;
}

/** Apply a transaction to a buffer, on screen or off. */
export function updateBuffer(buffer: CodeBuffer, spec: TransactionSpec): void {
  if (buffer.view) buffer.view.dispatch(spec);
  else buffer.state = buffer.state.update(spec).state;
}

export interface OpenBufferInput {
  vaultId: string;
  path: string;
  content: string;
  etag: string;
  /** Bytes served with `content`, when known (see decodeFileText). */
  sizeBytes?: number;
  /** Builds the state's extensions (setup, language, features) once the
   *  file's format and text are known. */
  extensions: (decoded: { text: string; format: FileFormat }) => Extension;
}

/** The fields every state showing a file carries (the status bar and saving
 *  read them): the text as last saved, and the file's format. */
/** The file's mode refuses writes ("0444"): the editor still edits it, as vim
 *  does, and a save asks before forcing the write (fileSync, kind "readonly"). */
export const setDiskLock = StateEffect.define<string | null>();

export const diskLockField = StateField.define<string | null>({
  create: () => null,
  update: (lock, tr) => {
    for (const e of tr.effects) if (e.is(setDiskLock)) return e.value;
    return lock;
  },
});

export function bufferFields(format: FileFormat): Extension {
  return [savedDocField, fileFormatField.init(() => format), diskLockField];
}

/** Follow what disk says of the file's mode; writes nothing when unchanged. */
export function syncDiskLock(buffer: CodeBuffer, lock: string | null | undefined): void {
  if (currentState(buffer).field(diskLockField) === (lock ?? null)) return;
  updateBuffer(buffer, { effects: setDiskLock.of(lock ?? null) });
}

export const MAX_CLEAN_BUFFERS = 40;
/** Total document size the cache holds before it evicts, in characters (a
 *  document's `length`, which is O(1) to read). Forty 3 MB files would be
 *  hundreds of megabytes of text and undo history otherwise. */
export const MAX_BUFFER_CHARS = 64 * 1024 * 1024;

/**
 * Buffers by key, least recently used evicted past either limit: a count, and
 * the total size of their documents. Only a clean buffer that is not on screen
 * can be evicted: dropping a dirty one would lose work, and a shown one is in
 * use. So the size bound is best effort; unsaved and shown text always stays.
 */
export class BufferCache {
  private buffers = new Map<string, CodeBuffer>();
  private clock = 0;
  /** A buffer left the cache (closed or evicted): whatever else holds its
   *  text for it can let go (fileSync drops the vault store's copy). */
  onDrop: ((buffer: CodeBuffer) => void) | null = null;

  constructor(
    private readonly limit = MAX_CLEAN_BUFFERS,
    private readonly charLimit = MAX_BUFFER_CHARS,
  ) {}

  get(key: string): CodeBuffer | undefined {
    return this.buffers.get(key);
  }

  all(): CodeBuffer[] {
    return [...this.buffers.values()];
  }

  dirty(): CodeBuffer[] {
    return this.all().filter((b) => b.dirty || b.merging);
  }

  /** The buffer for this file, created from the given text when there is none. */
  open(input: OpenBufferInput): CodeBuffer {
    const key = bufferKey(input.vaultId, input.path);
    const existing = this.buffers.get(key);
    if (existing) {
      this.touch(existing);
      return existing;
    }
    const decoded = decodeFileText(input.content, input.sizeBytes);
    const state = EditorState.create({
      doc: decoded.text,
      extensions: [bufferFields(decoded.format), input.extensions(decoded)],
    });
    const buffer: CodeBuffer = {
      key,
      vaultId: input.vaultId,
      path: input.path,
      state,
      view: null,
      scroll: null,
      baseEtag: input.etag,
      dirty: false,
      stale: null,
      merging: null,
      sizeBytes: input.sizeBytes ?? input.content.length,
      lastUsed: 0,
    };
    this.buffers.set(key, buffer);
    this.touch(buffer);
    this.evict(buffer);
    return buffer;
  }

  touch(buffer: CodeBuffer): void {
    buffer.lastUsed = ++this.clock;
  }

  /** `keepText`: what else holds this path's text stays (a file renamed onto
   *  the path brought it, and the next buffer opens from it). */
  close(key: string, opts?: { keepText?: boolean }): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.buffers.delete(key);
    if (!opts?.keepText) this.onDrop?.(buffer);
  }

  /** Drop clean, off-screen buffers, oldest first, until both limits hold
   *  (or nothing evictable is left); `keep` is the buffer being opened, about
   *  to go on screen. */
  evict(keep?: CodeBuffer): void {
    let count = this.buffers.size;
    const size = (b: CodeBuffer) => currentState(b).doc.length;
    let chars = 0;
    for (const b of this.buffers.values()) chars += size(b);
    if (count <= this.limit && chars <= this.charLimit) return;
    const candidates = this.all()
      .filter((b) => b !== keep && !b.dirty && !b.stale && !b.merging && !b.view)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const b of candidates) {
      if (count <= this.limit && chars <= this.charLimit) break;
      this.buffers.delete(b.key);
      this.onDrop?.(b);
      count--;
      chars -= size(b);
    }
  }
}

/** The app's one set of open buffers. */
export const codeBuffers = new BufferCache();
