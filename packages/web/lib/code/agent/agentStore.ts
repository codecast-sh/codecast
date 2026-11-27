// The editor's agent chrome: which session each folder is linked to, who is
// editing which file right now, and the two overlays (the session picker, the
// inline instruction). No CodeMirror here: the Files page reads presence for
// its tabs and tree without loading the editor chunk.
//
// Written on transitions a person sees (a link changes, a session starts or
// stops editing a file, an overlay opens), never per keystroke.

import { create } from "zustand";
import { emptyEditIndex, writerFor, type EditIndex } from "./attribution";
import type { AgentLink, LinkOverride } from "./sessions";
import type { CodeRange } from "./compose";

/** What runs once the person picks a session for an action that needed one. */
export type PickedThen = (sessionId: string) => void;

export interface PickerRequest {
  vaultId: string;
  /** Where to hang the menu (the status chip); null centers it. */
  anchor: { left: number; top: number; bottom: number } | null;
  then?: PickedThen;
  /** What the pick is for, which the menu names: a Cmd-L quote, the target of
   *  an inline instruction, or (absent) the folder's link itself. */
  action?: "quote" | "instruct";
  /** Start a new session here instead (the menu's "New session" row). Returns
   *  false when there is nothing to start it from. */
  newSession?: () => boolean;
}

export interface InlineRequest {
  id: number;
  vaultId: string;
  /** The session this instruction goes to, fixed when the box opened and
   *  changed only through the box's own picker: a re-ranked folder link never
   *  moves it while the person types. Null asks on Enter. */
  sessionId: string | null;
  /** The widget's host element in the editor, which the layer portals into. */
  host: HTMLElement | null;
  range: CodeRange;
  /** Called once the message is handed to the store. */
  onSent(sessionId: string, clientId: string): void;
  onClose(): void;
}

/** The text typed into an open inline box, kept outside React and the store
 *  (a keystroke writes neither) so the box gets it back when CodeMirror drops
 *  its widget and draws it again: a scroll far away, a buffer switch. */
const inlineDrafts = new Map<number, { text: string; focused: boolean }>();

export function inlineDraft(id: number): { text: string; focused: boolean } {
  let d = inlineDrafts.get(id);
  if (!d) inlineDrafts.set(id, (d = { text: "", focused: false }));
  return d;
}

/** A status bar chip's host, and its editor's way to start a session with the
 *  selection quoted (the picker's "New session here"). */
export interface ChipHost {
  el: HTMLElement;
  vaultId: string;
  newSession?: () => boolean;
}

interface AgentStoreState {
  /** The person's pick per vault. */
  overrides: Record<string, LinkOverride>;
  /** The resolved link per vault (AgentLayer keeps it current). */
  links: Record<string, AgentLink>;
  /** Live edit evidence per vault: who is editing which file now. */
  presence: Record<string, { root: string; index: EditIndex; digest: string }>;
  /** The session most likely behind a disk change that is waiting on a dirty
   *  buffer, per buffer key, captured when the change arrived. */
  conflictWriters: Record<string, string>;
  picker: PickerRequest | null;
  inline: InlineRequest | null;
  /** The status bar chips' host elements (one per editor), portalled into. */
  chips: ReadonlyArray<ChipHost>;
  addChip(el: HTMLElement, vaultId: string, newSession?: () => boolean): void;
  removeChip(el: HTMLElement): void;
  setOverride(vaultId: string, value: LinkOverride): void;
  /** Read the vault's saved pick into the store, once. */
  restoreOverride(vaultId: string): void;
  setLink(vaultId: string, link: AgentLink): void;
  /** `digest` names the evidence; an unchanged digest writes nothing. */
  setPresence(vaultId: string, root: string, index: EditIndex, digest: string): void;
  setConflictWriter(key: string, sessionId: string | null): void;
  openPicker(req: PickerRequest): void;
  closePicker(): void;
  openInline(req: Omit<InlineRequest, "id" | "host">): number;
  setInlineHost(id: number, host: HTMLElement | null): void;
  setInlineTarget(id: number, sessionId: string): void;
  closeInline(id?: number): void;
}

let inlineIds = 0;

// The person's pick per vault outlives a reload, beside the vault's code
// workspace (lib/code/workspace/persist): a vault is one folder on one
// machine, so the pick is this browser's. A pick whose session is gone is
// passed over by resolveLink until the person picks again.
const OVERRIDE_KEY = (vaultId: string) => `codecast:code-agent-link:v1:${vaultId}`;

function readOverride(vaultId: string): LinkOverride {
  try {
    return (typeof localStorage === "undefined" ? null : localStorage.getItem(OVERRIDE_KEY(vaultId))) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeOverride(vaultId: string, value: LinkOverride): void {
  try {
    if (value) localStorage.setItem(OVERRIDE_KEY(vaultId), value);
    else localStorage.removeItem(OVERRIDE_KEY(vaultId));
  } catch {
    // Storage full or blocked: the pick lasts for this page.
  }
}

const sameLink = (a: AgentLink | undefined, b: AgentLink) => !!a && a.sessionId === b.sessionId && a.source === b.source;

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  overrides: {},
  links: {},
  presence: {},
  conflictWriters: {},
  picker: null,
  inline: null,
  chips: [],
  addChip: (el, vaultId, newSession) => {
    if (get().chips.some((c) => c.el === el && c.vaultId === vaultId)) return;
    set((s) => ({ chips: [...s.chips.filter((c) => c.el !== el), { el, vaultId, newSession }] }));
  },
  removeChip: (el) => {
    if (!get().chips.some((c) => c.el === el)) return;
    set((s) => ({ chips: s.chips.filter((c) => c.el !== el) }));
  },
  setOverride: (vaultId, value) => {
    if (get().overrides[vaultId] === value) return;
    writeOverride(vaultId, value);
    set((s) => ({ overrides: { ...s.overrides, [vaultId]: value } }));
  },
  restoreOverride: (vaultId) => {
    if (vaultId in get().overrides) return;
    const value = readOverride(vaultId);
    set((s) => ({ overrides: { ...s.overrides, [vaultId]: value } }));
  },
  setLink: (vaultId, link) => {
    if (sameLink(get().links[vaultId], link)) return;
    set((s) => ({ links: { ...s.links, [vaultId]: link } }));
  },
  setPresence: (vaultId, root, index, digest) => {
    const cur = get().presence[vaultId];
    if (cur && cur.root === root && cur.digest === digest) return;
    set((s) => ({ presence: { ...s.presence, [vaultId]: { root, index, digest } } }));
  },
  setConflictWriter: (key, sessionId) => {
    const current = get().conflictWriters[key];
    if ((current ?? null) === sessionId) return;
    set((s) => {
      const next = { ...s.conflictWriters };
      if (sessionId) next[key] = sessionId;
      else delete next[key];
      return { conflictWriters: next };
    });
  },
  openPicker: (req) => set({ picker: req }),
  closePicker: () => set({ picker: null }),
  openInline: (req) => {
    const id = ++inlineIds;
    const prev = get().inline;
    if (prev) {
      inlineDrafts.delete(prev.id);
      prev.onClose();
    }
    set({ inline: { ...req, id, host: null } });
    return id;
  },
  setInlineHost: (id, host) => {
    const cur = get().inline;
    if (!cur || cur.id !== id || cur.host === host) return;
    set({ inline: { ...cur, host } });
  },
  setInlineTarget: (id, sessionId) => {
    const cur = get().inline;
    if (!cur || cur.id !== id || cur.sessionId === sessionId) return;
    set({ inline: { ...cur, sessionId } });
  },
  closeInline: (id) => {
    const cur = get().inline;
    if (!cur || (id !== undefined && cur.id !== id)) return;
    inlineDrafts.delete(cur.id);
    set({ inline: null });
  },
}));

const EMPTY = emptyEditIndex();

/** The session editing a vault file right now, or null. */
export function presenceOf(state: Pick<AgentStoreState, "presence">, vaultId: string, path: string): string | null {
  const p = state.presence[vaultId];
  if (!p) return null;
  return writerFor(p.index ?? EMPTY, joinRoot(p.root, path));
}

/** A vault path made absolute. */
export function joinRoot(root: string, path: string): string {
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Hook: the session editing this file now (a stable string or null). */
export function usePresence(vaultId: string | null | undefined, path: string): string | null {
  return useAgentStore((s) => (vaultId ? presenceOf(s, vaultId, path) : null));
}
