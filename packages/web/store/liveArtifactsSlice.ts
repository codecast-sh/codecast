// Live artifact writes (boards, sheets, dashboards). The collections are
// registered in clientSyncRegistry.live.ts; this slice holds the actions.
// Each patches the element rows on the draft so the page moves in the same
// tick, and rides `dispatch` to the side effect of the same name
// (convex/dispatch.ts), which calls liveArtifacts' one write path, the same
// one the CLI writes through. The rows' field locks hold the optimistic values
// until the server's echo carries them.
//
// Components never call these directly: components/live/useLiveArtifact.ts
// batches gestures (preview + commit) and keeps the undo stack.
import { action, asyncAction, sync } from "./mutativeMiddleware";
import { applyOp, fromElement, type ArtifactOp, type ElementState } from "@codecast/shared/artifacts";

export type LiveLayer = "main" | "draft" | "comments";

/** The store key of one element row. */
export const liveRowId = (docId: string, layer: LiveLayer, key: string) => `${docId}|${layer}|${key}`;

const ROW_META = new Set(["_id", "doc_id", "layer", "key", "kind", "rev", "by", "at", "deleted", "dead"]);

/** Write an element state onto a store row in place: fields flat, removed fields deleted. */
export function writeRowState(row: Record<string, any>, state: ElementState) {
  for (const f of Object.keys(row)) if (!ROW_META.has(f) && !(f in state.fields)) delete row[f];
  for (const [f, val] of Object.entries(state.fields)) if (row[f] !== val) row[f] = val;
  row.kind = state.kind;
  if (state.deleted) row.deleted = true;
  else if (row.deleted) delete row.deleted;
}

/** Apply ops to the liveElements slice (a draft or a plain object). Shared with the tests. */
export function applyOpsToRows(rows: Record<string, any>, docId: string, layer: LiveLayer, ops: readonly ArtifactOp[], by?: string) {
  for (const op of ops) {
    const id = liveRowId(docId, layer, op.k);
    let row = rows[id];
    let prev: ElementState | undefined = row ? fromElement(row) : undefined;
    // A draft edit of an element the draft has not touched starts from main.
    if (!row && layer === "draft") {
      const main = rows[liveRowId(docId, "main", op.k)];
      if (main) prev = fromElement(main);
    }
    if ("set" in op && (!prev || prev.deleted)) continue;
    const next = applyOp(prev, op);
    if (!row) {
      row = { _id: id, doc_id: docId, layer, key: op.k, kind: next.kind, rev: 0, ...(by ? { by } : {}) };
      rows[id] = row;
    }
    writeRowState(row, next);
  }
}

type LiveDraft = {
  liveElements: Record<string, any>;
  liveHeads: Record<string, any>;
  liveVersions: Record<string, any>;
  currentUser?: { _id: string; name?: string } | null;
};

export type LiveArtifactsSliceActions = {
  /** One batch of element ops, painted now and sent as one write. Resolves to the server's revision once it lands. */
  applyLiveOps: (docId: string, layer: LiveLayer, ops: ArtifactOp[], clientId?: string) => Promise<{ rev: number; keys: string[] } | null>;
  /** Start, save or discard the doc's draft. Save resolves to the revision it wrote. */
  /** `draftAt` names the draft being closed, so a retried close never hits a newer draft. */
  liveDraft: (docId: string, op: "start" | "save" | "discard", draftAt?: number) => Promise<{ rev?: number } | null>;
  /**
   * The server has a write and the feed has caught up past it: drop the field
   * locks it planted (those no newer than `before`). Whatever the server holds
   * for those rows now is authoritative, even when a later writer changed it
   * before this tab saw its own echo.
   */
  settleLiveRows: (rowIds: string[], before: number) => void;
  /** A named checkpoint of the artifact as it is now. */
  liveCheckpoint: (docId: string, label?: string) => void;
  /** Who may change the artifact: everyone who can open it ("team"), or its owner and `editors` ("owners"). Owner only. */
  liveSetEditAccess: (docId: string, edit: "team" | "owners", editors: string[]) => void;
  /** A viewer asks the owner to let them edit. Resolves once the owner is notified. */
  liveAskToEdit: (docId: string) => Promise<{ asked: boolean } | null>;
};

// The middleware wraps an asyncAction so its CALLER receives the server
// result as a promise; the body returns nothing.
type LiveSliceImpl = Omit<LiveArtifactsSliceActions, "applyLiveOps" | "liveDraft" | "liveAskToEdit"> & {
  liveAskToEdit: (docId: string) => void;
  applyLiveOps: (docId: string, layer: LiveLayer, ops: ArtifactOp[], clientId?: string) => void;
  liveDraft: (docId: string, op: "start" | "save" | "discard", draftAt?: number) => void;
};

export function createLiveArtifactsSlice(): LiveArtifactsSliceActions {
  const impl: LiveSliceImpl = {
    applyLiveOps: asyncAction(function (this: LiveDraft, docId: string, layer: LiveLayer, ops: ArtifactOp[]) {
      const me = this.currentUser?._id;
      applyOpsToRows(this.liveElements, docId, layer, ops, me ? `u:${me}` : undefined);
      if (layer === "draft") {
        const head = this.liveHeads[docId] ?? (this.liveHeads[docId] = { _id: docId, head: 0 });
        if (!head.draft) head.draft = { by: me ? `u:${me}` : "", by_name: this.currentUser?.name ?? "You", at: Date.now() };
      }
    }),

    // Closing the draft hides its rows at once (the page overlays the draft
    // only while one is open); the server retires them and the feed drops
    // them. Rows are never deleted here: a delete would plant an exclude
    // that hides the next draft's rows for the same keys.
    liveDraft: asyncAction(function (this: LiveDraft, docId: string, op: "start" | "save" | "discard", _draftAt?: number) {
      const head = this.liveHeads[docId] ?? (this.liveHeads[docId] = { _id: docId, head: 0 });
      const me = this.currentUser?._id;
      if (op === "start") {
        if (!head.draft) head.draft = { by: me ? `u:${me}` : "", by_name: this.currentUser?.name ?? "You", at: Date.now() };
        return;
      }
      if (op === "save") {
        const prefix = `${docId}|draft|`;
        for (const id of Object.keys(this.liveElements)) {
          if (!id.startsWith(prefix)) continue;
          const row = this.liveElements[id];
          const state = fromElement(row);
          const ops: ArtifactOp[] = state.deleted ? [{ k: row.key, del: true }] : [{ k: row.key, put: { kind: state.kind, ...state.fields } as any }];
          applyOpsToRows(this.liveElements, docId, "main", ops);
        }
      }
      head.draft = null;
    }),

    settleLiveRows: sync(function (this: { pending: Record<string, any> }, rowIds: string[], before: number) {
      const ids = new Set(rowIds);
      const prefix = "liveElements:";
      for (const key of Object.keys(this.pending)) {
        if (!key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length, key.lastIndexOf(":"));
        if (!ids.has(id)) continue;
        const entry = this.pending[key];
        if (entry?.type === "field" && (entry.ts ?? 0) <= before) delete this.pending[key];
      }
    }),

    // Nothing to paint: the version list fills from the server.
    // The version shows in History at once: a stub at the current head, which the
    // server's row for the same revision replaces in the reader (useLiveVersions).
    liveCheckpoint: action(function (this: LiveDraft, docId: string, label?: string) {
      const rev = Number(this.liveHeads[docId]?.head ?? 0);
      const id = `stub:${docId}:${rev}`;
      this.liveVersions[id] = {
        _id: id, doc_id: docId, rev, label: label?.trim() || "Saved version", reason: "manual",
        by: this.currentUser?._id ? `u:${this.currentUser._id}` : "", by_name: this.currentUser?.name ?? "You", at: Date.now(), stub: true,
      };
    }),

    liveSetEditAccess: action(function (this: LiveDraft, docId: string, edit: "team" | "owners", editors: string[]) {
      const head = this.liveHeads[docId] ?? (this.liveHeads[docId] = { _id: docId, head: 0 });
      head.edit = edit;
      head.editors = editors;
    }),

    // Nothing to paint: the owner's notification is the whole effect.
    liveAskToEdit: asyncAction(function (this: LiveDraft, _docId: string) {}),
  };
  return impl as unknown as LiveArtifactsSliceActions;
}
