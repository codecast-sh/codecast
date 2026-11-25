// Code editor chrome state: what the tabs, headers and strips around an editor
// show. Never written per keystroke (docs/architecture/code-editor.md,
// contract 1): `dirty` changes only when a buffer goes from clean to dirty or
// back, and `conflicts` only when disk and a buffer disagree or agree again.
// The editor's own state (document, selection, undo) lives in CodeMirror.

import { create } from "zustand";
import { emptyWorkspace, type Workspace } from "../lib/code/workspace/model";
import { loadWorkspace } from "../lib/code/workspace/persist";

export type CodeConflict =
  /** Disk changed under unsaved edits; the next save merges. */
  | { kind: "stale" }
  /** The editor is showing a merge against disk. `remaining` counts the
   *  chunks still differing; `conflicts` the ones both sides changed. */
  | { kind: "merge"; remaining: number; conflicts: number }
  /** A save found the file deleted on disk; the buffer still holds its text. */
  | { kind: "deleted" }
  /** The last save failed for a reason other than a conflict. */
  | { kind: "error"; message: string };

/** A buffer's identity: one per file per vault. Here rather than in
 *  lib/code/buffers so Files can ask about a buffer without loading the editor. */
export function bufferKey(vaultId: string, path: string): string {
  return `${vaultId}\u0000${path}`;
}

interface CodeStoreState {
  /** Buffer keys (bufferKey) with unsaved changes. */
  dirty: Record<string, true>;
  conflicts: Record<string, CodeConflict>;
  setDirty: (key: string, dirty: boolean) => void;
  setConflict: (key: string, conflict: CodeConflict | null) => void;
  /** The code workspace per vault: groups, tabs, history. Changes when a tab
   *  opens, closes, moves or gains focus; never per keystroke. */
  workspaces: Record<string, Workspace>;
  /** Apply a workspace change; a change that returns the same value writes nothing. */
  updateWorkspace: (vaultId: string, fn: (ws: Workspace) => Workspace) => void;
}

/** A vault's workspace: the one in the store, else the one persisted for it
 *  (read synchronously, so a reload paints its tabs on the first frame). */
export function workspaceFor(vaultId: string): Workspace {
  return useCodeStore.getState().workspaces[vaultId] ?? loadWorkspace(vaultId) ?? emptyWorkspace();
}

const sameConflict = (a: CodeConflict | undefined, b: CodeConflict | null) =>
  a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

export const useCodeStore = create<CodeStoreState>((set, get) => ({
  dirty: {},
  conflicts: {},
  workspaces: {},
  updateWorkspace: (vaultId, fn) => {
    const current = get().workspaces[vaultId] ?? workspaceFor(vaultId);
    const next = fn(current);
    if (next === get().workspaces[vaultId]) return;
    set((s) => ({ workspaces: { ...s.workspaces, [vaultId]: next } }));
  },
  setDirty: (key, dirty) => {
    if (!!get().dirty[key] === dirty) return;
    set((s) => {
      const next = { ...s.dirty };
      if (dirty) next[key] = true;
      else delete next[key];
      return { dirty: next };
    });
  },
  setConflict: (key, conflict) => {
    if (sameConflict(get().conflicts[key], conflict)) return;
    set((s) => {
      const next = { ...s.conflicts };
      if (conflict) next[key] = conflict;
      else delete next[key];
      return { conflicts: next };
    });
  },
}));
