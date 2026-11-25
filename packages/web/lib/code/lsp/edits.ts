// Applying a language server's WorkspaceEdit (a rename, a code action, a
// server's workspace/applyEdit). A file with an open buffer gets one undoable
// transaction, on screen or off, and stays unsaved for the person to review
// and save. A file with no buffer is read from disk and written back with a
// compare-and-swap against the etag of that read (contract 4): when disk moves
// between the read and the write, nothing is written and the file is reported
// as a conflict. A change on disk before the read is not detected; the server
// computed its edit from disk too, and normally republishes after it.
//
// An edit naming a document version (documentChanges) is refused for a file
// whose open document has moved past that version, unless a mapping from the
// request that produced it carries the positions over. A buffer with unsaved
// changes whose document this server does not hold (never shown to it, or
// reaped) is skipped: the server computed the positions from disk, and they
// do not hold in the edited text.

import type * as lsp from "./protocol";
import { Text, type ChangeSpec, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { WorkspaceMapping } from "@codemirror/lsp-client";
import { currentState, decodeFileText, savedDocField, type CodeBuffer } from "../buffers";
import { resolveUri } from "./uri";

export interface EditFileIO {
  read(path: string): Promise<{ content: string; etag: string; size?: number } | null>;
  /** Throws an error with `name === "VaultWriteConflict"` (or a
   *  VaultWriteConflict) when disk is no longer at `etag`. */
  write(path: string, content: string, etag: string): Promise<unknown>;
}

export interface EditTarget extends EditFileIO {
  rootPath: string;
  buffer(path: string): CodeBuffer | undefined;
  applyToBuffer(buffer: CodeBuffer, spec: TransactionSpec): void;
}

export interface EditReport {
  /** Vault paths edited in their open buffers (unsaved). */
  buffers: string[];
  /** Vault paths rewritten on disk. */
  written: string[];
  /** Disk moved since the server computed the edit: left untouched. */
  conflicts: string[];
  /** Not applied, with why (outside the vault, a file operation, a failure). */
  skipped: { path: string; reason: string }[];
}

type Edit = { range: lsp.Range; newText: string };

/** Every text edit in a WorkspaceEdit by URI, in the order given. File
 *  operations (create, rename, delete) are returned separately. */
export function collectEdits(edit: lsp.WorkspaceEdit): { byUri: Map<string, Edit[]>; fileOps: string[]; versions: Map<string, number> } {
  const byUri = new Map<string, Edit[]>();
  const fileOps: string[] = [];
  const versions = new Map<string, number>();
  const add = (uri: string, edits: readonly Edit[]) => {
    if (!edits.length) return;
    byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
  };
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        add(change.textDocument.uri, change.edits as Edit[]);
        if (typeof change.textDocument.version === "number") versions.set(change.textDocument.uri, change.textDocument.version);
      }
      else fileOps.push("kind" in change ? `${change.kind} ${"uri" in change ? change.uri : change.newUri}` : "file operation");
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  return { byUri, fileOps, versions };
}

/** An LSP position as an offset in `doc`, clamped to the document. */
export function offsetIn(doc: Text, pos: lsp.Position): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return line.from + Math.min(Math.max(0, pos.character), line.length);
}

function changesFor(doc: Text, edits: readonly Edit[], map?: (pos: lsp.Position, assoc: number) => number): ChangeSpec[] {
  return edits.map((e) => ({
    from: map ? map(e.range.start, 1) : offsetIn(doc, e.range.start),
    to: map ? map(e.range.end, -1) : offsetIn(doc, e.range.end),
    insert: e.newText,
  }));
}

/** The buffer's text differs from what disk held at its last load or save. */
export function hasUnsavedText(state: EditorState): boolean {
  const saved = state.field(savedDocField, false);
  return !!saved && !state.doc.eq(saved);
}

const isConflict = (err: unknown) => err instanceof Error && (err.name === "VaultWriteConflict" || err.constructor?.name === "VaultWriteConflict");

/** Rewrite one file's bytes with LSP edits, keeping its line separator and BOM. */
export function editFileText(content: string, edits: readonly Edit[], size?: number): string {
  const { text, format } = decodeFileText(content, size);
  const doc = Text.of(text.split(/\r\n|\r|\n/));
  // Edits from one WorkspaceEdit never overlap and refer to the original text.
  const sorted = [...edits].sort((a, b) => offsetIn(doc, a.range.start) - offsetIn(doc, b.range.start));
  let out = "";
  let at = 0;
  const flat = doc.toString();
  for (const e of sorted) {
    const from = offsetIn(doc, e.range.start);
    const to = offsetIn(doc, e.range.end);
    out += flat.slice(at, from) + e.newText.replace(/\r\n|\r/g, "\n");
    at = Math.max(at, to);
  }
  out += flat.slice(at);
  const joined = format.lineSeparator === "\n" ? out : out.replace(/\n/g, format.lineSeparator);
  return format.bom ? "﻿" + joined : joined;
}

export interface ApplyEditOptions {
  /** From the request the edit answers (a rename): carries positions over what
   *  the person typed since. */
  mapping?: WorkspaceMapping;
  /** The open document for a server URI, as the workspace spells it (the
   *  mapping is keyed by that spelling) and at the version the server has. */
  document?: (uri: string) => { uri: string; version: number } | null;
  userEvent?: string;
}

/** Apply a WorkspaceEdit. */
export async function applyWorkspaceEdit(edit: lsp.WorkspaceEdit, target: EditTarget, opts: ApplyEditOptions = {}): Promise<EditReport> {
  const report: EditReport = { buffers: [], written: [], conflicts: [], skipped: [] };
  const { byUri, fileOps, versions } = collectEdits(edit);
  for (const op of fileOps) report.skipped.push({ path: op, reason: "file operations are not supported" });

  const disk: Promise<void>[] = [];
  for (const [uri, edits] of byUri) {
    const where = resolveUri(target.rootPath, uri);
    if (!where.inside) {
      report.skipped.push({ path: where.absPath ?? uri, reason: "outside this folder" });
      continue;
    }
    const path = where.path;
    const buffer = target.buffer(path);
    if (buffer) {
      const state = currentState(buffer);
      if (state.readOnly) {
        report.skipped.push({ path, reason: "read-only" });
        continue;
      }
      const open = opts.document?.(uri) ?? null;
      if (!open && hasUnsavedText(state)) {
        report.skipped.push({ path, reason: "unsaved, not open in the server" });
        continue;
      }
      const key = open?.uri ?? uri;
      const mapping = opts.mapping?.getMapping(key) ? opts.mapping : undefined;
      const version = versions.get(uri);
      if (!mapping && open && version !== undefined && version !== open.version) {
        report.skipped.push({ path, reason: "edited since the server computed this" });
        continue;
      }
      const changes = changesFor(state.doc, edits, mapping ? (pos, assoc) => mapping.mapPosition(key, pos, assoc) : undefined);
      target.applyToBuffer(buffer, { changes, userEvent: opts.userEvent ?? "lsp.edit", scrollIntoView: false });
      report.buffers.push(path);
      continue;
    }
    disk.push(
      (async () => {
        try {
          const file = await target.read(path);
          if (!file) return void report.skipped.push({ path, reason: "missing on disk" });
          await target.write(path, editFileText(file.content, edits, file.size), file.etag);
          report.written.push(path);
        } catch (err) {
          if (isConflict(err)) report.conflicts.push(path);
          else report.skipped.push({ path, reason: err instanceof Error ? err.message : String(err) });
        }
      })(),
    );
  }
  await Promise.all(disk);
  return report;
}

/** Files touched, for a one-line summary chip. */
export function editedCount(r: EditReport): number {
  return r.buffers.length + r.written.length;
}
