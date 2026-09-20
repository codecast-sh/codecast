"use client";
// The org record, connected (docs/architecture/org-staffing.md S21). The
// feeders fill the store (hooks/useSyncOrgLog); this file paints from it
// through wake signatures and writes through the store: Undo and Redo are
// actions that mark the entry in the same tick and ride the named dispatch
// side effects (undoOrgChange, redoOrgChange). A refusal puts the entry back
// through the org intent journal and toasts, like every other org write.
//
// Two mounts: the History tab of the org page's panel (the whole workspace)
// and the History section of a role's Scope view (`roleId`, a short list).
import { useCallback, useMemo, useState } from "react";
import { orgLogEntryLine, type OrgLogEntry, type OrgLogRow } from "@codecast/shared/contracts/orgChange";
import { useInboxStore } from "../../../store/inboxStore";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { useOrgUndoPreview, useSyncOrgLog, useSyncOrgLogEntry } from "../../../hooks/useSyncOrgLog";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { OrgHistoryView, OrgLogRows, OrgUndoPreviewCard, type OrgHistoryState } from "./OrgHistoryView";
import { orgLogFixture } from "./orgLogFixture";

/** The fields an entry paints: a push that moved none of them wakes nothing. */
const entrySig = (e: OrgLogEntry) => `${e.seq}|${e.row_count}|${e.undone_by?.batch ?? ""}|${e.undone_by?.at ?? ""}|${e.may_undo ? 1 : 0}`;
const rowSig = (r: OrgLogRow) => String(r.seq);
const bySeq = (a: OrgLogRow, b: OrgLogRow) => a.seq - b.seq;

function ConnectedRows({ entry }: { entry: OrgLogEntry }) {
  const { ready } = useSyncOrgLogEntry(entry._id);
  const where = useCallback((r: OrgLogRow) => r.batch === entry._id, [entry._id]);
  const rows = useCollectionRows<OrgLogRow>("orgLogRows", { where, sig: rowSig, sort: bySeq });
  return <OrgLogRows entry={entry} rows={rows.length > 0 || ready ? rows : undefined} />;
}

function ConnectedPreview({ entry, redo, close }: { entry: OrgLogEntry; redo: boolean; close: () => void }) {
  const { preview, error } = useOrgUndoPreview(entry._id);
  const confirm = useCallback((withBatches: string[]) => {
    const opts = { with: withBatches, line: orgLogEntryLine(entry) };
    const store = useInboxStore.getState();
    if (redo) store.redoOrgChange(entry._id, opts);
    else store.undoOrgChange(entry._id, opts);
    close();
  }, [entry, redo, close]);
  return <OrgUndoPreviewCard entry={entry} redo={redo} preview={error ? null : preview} onConfirm={confirm} onCancel={close} />;
}

export function OrgHistory({ roleId, limit, onMore }: { roleId?: string; limit?: number; onMore?: () => void }) {
  const now = useCoarseNow(60_000);
  const { ready, missing, error } = useSyncOrgLog({ role: roleId ?? null });
  const all = useWorkspaceCollection<OrgLogEntry>("orgLog", entrySig);
  const entries = useMemo(() => roleId ? all.filter((e) => e.role_ids.includes(roleId)) : all, [all, roleId]);
  const state: OrgHistoryState = missing ? "missing" : error ? "error" : ready ? "ready" : "loading";
  return (
    <OrgHistoryView
      entries={entries}
      now={now}
      state={state}
      limit={limit}
      onMore={onMore}
      empty={roleId ? "Nothing has changed this role yet. Every change to it shows here, with who made it and a way to take it back." : undefined}
      renderRows={(e) => <ConnectedRows entry={e} />}
      renderPreview={(e, redo, close) => <ConnectedPreview entry={e} redo={redo} close={close} />}
    />
  );
}

/** The DEV preview's record (`?preview=1`): the fixture, with undo and redo
 *  kept in local state so the whole loop can be walked with no server. */
export function OrgHistoryPreview({ roleId, limit, onMore }: { roleId?: string; limit?: number; onMore?: () => void }) {
  const now = useCoarseNow(60_000);
  const fixture = useMemo(() => orgLogFixture(Date.now()), []);
  const [undone, setUndone] = useState<Record<string, OrgLogEntry["undone_by"] | null>>({});
  const entries = useMemo(() => fixture.entries
    .filter((e) => !roleId || e.role_ids.includes(roleId))
    .map((e) => e._id in undone ? { ...e, undone_by: undone[e._id] ?? undefined } : e), [fixture, undone, roleId]);
  return (
    <OrgHistoryView
      entries={entries}
      now={now}
      limit={limit}
      onMore={onMore}
      renderRows={(e) => <OrgLogRows entry={e} rows={fixture.rows[e._id]} />}
      renderPreview={(e, redo, close) => (
        <OrgUndoPreviewCard
          entry={e}
          redo={redo}
          preview={fixture.previews[e._id] ?? null}
          onCancel={close}
          onConfirm={(withBatches) => {
            const mark = redo ? null : { batch: "preview", user_id: e.actor.user_id, name: e.actor.name, at: Date.now() };
            setUndone((cur) => ({ ...cur, ...Object.fromEntries([e._id, ...withBatches].map((b) => [b, mark])) }));
            close();
          }}
        />
      )}
    />
  );
}
