// Saving the vimrc overlay (~/.codecast/editor/vimrc) from the editor on the
// settings page. The buffer is a real code buffer, so the editor, vim, undo
// and hot exit all behave as in Files, but it is not a vault file: its write
// goes through the daemon's overlay route, and a write is followed by a vimrc
// reload so every editor runs the new config at once.

import { codeBuffers, currentState, encodeFileText, isDirty, setSavedDoc, type CodeBuffer } from "../../../lib/code/buffers";
import { applyToBuffer } from "../../../lib/code/fileSync";

/** The pseudo-vault the overlay buffer lives in. Autosave and vault writes
 *  never touch it; vim always runs in it. */
export const OVERLAY_VAULT = "codecast:editor-vimrc";

/** A version tag for overlay text, so a reload that brings different text
 *  reaches a clean buffer as a disk change, and the same text does not. */
export function overlayEtag(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  return `overlay:${content.length}:${(h >>> 0).toString(36)}`;
}

export type OverlaySaveResult = { kind: "unchanged" } | { kind: "saved"; bytes: number } | { kind: "error"; message: string };

/** Write the buffer's text as the overlay, mark it saved, then reload. */
export async function saveOverlay(
  buffer: CodeBuffer,
  write: (content: string) => Promise<{ bytes: number }>,
  reload: () => unknown,
): Promise<OverlaySaveResult> {
  const state = currentState(buffer);
  if (!isDirty(state)) return { kind: "unchanged" };
  const doc = state.doc;
  const content = encodeFileText(state);
  let res: { bytes: number };
  try {
    res = await write(content);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  // The text written is the saved version, even if typing continued meanwhile.
  buffer.baseEtag = overlayEtag(content);
  applyToBuffer(buffer, { effects: setSavedDoc.of(doc) });
  void Promise.resolve(reload()).catch(() => {});
  return { kind: "saved", bytes: res.bytes };
}

/** The overlay buffer, when one is open. */
export function overlayBuffer(path: string): CodeBuffer | undefined {
  return codeBuffers.all().find((b) => b.vaultId === OVERLAY_VAULT && b.path === path);
}
