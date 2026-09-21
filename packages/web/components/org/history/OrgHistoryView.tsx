"use client";
// The org record as a person reads it (docs/architecture/org-staffing.md S21,
// "The page"): entries newest first, grouped by day, one entry per gesture
// with who, when, which door and one sentence, and the rows behind a fold. An
// entry that was taken back stays in place, struck, with who took it back.
//
// This file is the pure half: it paints what it is handed and owns no read
// and no write, so the History tab, a role's Scope view, the DEV preview and
// the mount tests all draw the same thing. OrgHistory.tsx is the half that
// reads the store and writes through it.
//
// Every sentence is the row contract's (orgLogLine, orgLogEntryLine,
// orgLogEffectLines), which call the proposal page's own writers, so this
// page has no wording of its own for a change.
import { useState, type ReactNode } from "react";
import { ChevronRight, FileText, Flag, FolderKanban, History, Network, Redo2, Settings2, Terminal, Undo2 } from "lucide-react";
import { leftAloneLine, orgLogEffectLines, orgLogEntryLine, orgLogLine, type OrgLogDoor, type OrgLogEntry, type OrgLogRow, type OrgUndoPreview } from "@codecast/shared/contracts/orgChange";
import { groupOrgLogByDay, orgLogClock, orgLogDoorWords, orgUndoCannotLine } from "@codecast/shared/contracts/orgLog";
import { cn } from "../../../lib/utils";
import { OrgButton } from "../OrgButton";
import { ORG_LOG_FOLD_ROWS } from "../../../lib/orgHistoryView";

const DOOR_ICON: Record<OrgLogDoor, typeof FileText> = {
  proposal: FileText,
  settings: Settings2,
  chart: Network,
  project_page: FolderKanban,
  initiative: Flag,
  cli: Terminal,
  history: History,
};

const hairline = "color-mix(in srgb, var(--sol-border) 28%, transparent)";

export type OrgHistoryState = "ready" | "loading" | "missing" | "error";

export type OrgHistoryViewProps = {
  entries: OrgLogEntry[];
  now: number;
  state?: OrgHistoryState;
  /** A short list (a role's Scope view): the newest `limit`, then `onMore`. */
  limit?: number;
  onMore?: () => void;
  /** The rows of an entry, drawn when its fold opens. */
  renderRows: (entry: OrgLogEntry) => ReactNode;
  /** What an undo (or a redo) will do, drawn when the person asks for it. */
  renderPreview: (entry: OrgLogEntry, redo: boolean, close: () => void) => ReactNode;
  /** What the empty record says: the whole workspace, or one role. */
  empty?: string;
};

export function OrgHistoryView({ entries, now, state = "ready", limit, onMore, renderRows, renderPreview, empty }: OrgHistoryViewProps) {
  const [openFold, setOpenFold] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ batch: string; redo: boolean } | null>(null);

  // A populated cache paints at once; the skeleton is for a cold one only.
  if (entries.length === 0) {
    if (state === "loading") return <HistorySkeleton />;
    return (
      <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-dim)" }} data-org-history-empty={state}>
        {state === "missing" ? "The record is not on this server yet. Changes made after it arrives will show here, each with a way back."
          : state === "error" ? "The record could not be read. It will show here once the connection is back."
          : empty ?? "Nothing has changed the organization yet. Every change made from now on shows here, with who made it and a way to take it back."}
      </p>
    );
  }

  const groups = groupOrgLogByDay(entries, now);
  let left = limit ?? Infinity;
  const shown = groups.map((g) => { const take = g.entries.slice(0, Math.max(0, left)); left -= take.length; return { ...g, entries: take }; }).filter((g) => g.entries.length > 0);
  const hidden = entries.length - shown.reduce((n, g) => n + g.entries.length, 0);

  return (
    <div data-org-history>
      {shown.map((g) => (
        <section key={g.day} className="mb-5 last:mb-0" data-org-history-day={g.label}>
          <h3 className="flex items-center gap-2.5 mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>
            {g.label}
            <span className="flex-1 h-px" style={{ background: hairline }} />
          </h3>
          <ol className="relative">
            {/* the rail the entries hang from */}
            <span aria-hidden className="absolute left-[10.5px] top-3 bottom-3 w-px" style={{ background: hairline }} />
            {g.entries.map((e) => (
              <Entry
                key={e._id}
                entry={e}
                foldOpen={openFold === e._id}
                onFold={() => setOpenFold((cur) => cur === e._id ? null : e._id)}
                asking={asking?.batch === e._id ? asking.redo : null}
                onAsk={(redo) => setAsking({ batch: e._id, redo })}
                rows={openFold === e._id ? renderRows(e) : null}
                preview={asking?.batch === e._id ? renderPreview(e, asking.redo, () => setAsking(null)) : null}
              />
            ))}
          </ol>
        </section>
      ))}
      {hidden > 0 && onMore && (
        <button type="button" onClick={onMore} className="ml-[34px] text-[11.5px] text-sol-violet hover:underline underline-offset-2" data-org-history-more={hidden}>
          {hidden} earlier {hidden === 1 ? "change" : "changes"}
        </button>
      )}
    </div>
  );
}

function Entry({ entry, foldOpen, onFold, asking, onAsk, rows, preview }: {
  entry: OrgLogEntry;
  foldOpen: boolean;
  onFold: () => void;
  /** null = no preview open; else whether the open preview is a redo. */
  asking: boolean | null;
  onAsk: (redo: boolean) => void;
  rows: ReactNode;
  preview: ReactNode;
}) {
  const undone = entry.undone_by;
  const Icon = entry.gesture === "undo" ? Undo2 : entry.gesture === "redo" ? Redo2 : DOOR_ICON[entry.door] ?? History;
  // The fold holds the rows of a gesture that made several, or what one row
  // did beyond its subject; a row that did nothing else has nothing to unfold.
  const effects = entry.lead ? orgLogEffectLines(entry.lead).length : 0;
  const foldLabel = entry.row_count > 1 ? `See all ${entry.row_count}` : effects > 0 ? "What else it did" : null;
  // An undo is itself taken back by applying the original again, so the one
  // way back sits on the entry it names, never on both.
  const mayAct = entry.may_undo && entry.gesture !== "undo" && entry.gesture !== "redo";

  return (
    <li className="relative pl-[34px] pb-4 last:pb-0" data-org-history-entry={entry._id} data-undone={undone ? "" : undefined}>
      <span aria-hidden className="absolute left-0 top-0 w-[22px] h-[22px] rounded-full inline-flex items-center justify-center border" style={{ background: "var(--sol-bg)", borderColor: hairline, color: undone ? "var(--sol-text-dim)" : entry.door === "proposal" ? "var(--sol-violet)" : "var(--sol-text-muted)" }}>
        <Icon className="w-3 h-3" />
      </span>
      <p className={cn("text-[13px] leading-snug", undone && "line-through decoration-1")} style={{ color: undone ? "var(--sol-text-dim)" : "var(--sol-text)" }} data-org-history-line>
        {orgLogEntryLine(entry)}
      </p>
      <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-org-history-meta>
        {entry.actor.name} · {orgLogClock(entry.at)} · {orgLogDoorWords(entry)}
      </p>
      {undone && (
        <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--sol-text-muted)" }} data-org-history-undone-by>
          Taken back by {undone.name}, {orgLogClock(undone.at)}
        </p>
      )}
      {(foldLabel || mayAct) && asking === null && (
        <div className="mt-1.5 flex items-center gap-2">
          {foldLabel && (
            <button type="button" onClick={onFold} aria-expanded={foldOpen} className="inline-flex items-center gap-1 h-6 -ml-1 px-1 rounded text-[11.5px] transition-colors hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} data-org-history-fold>
              <ChevronRight className={cn("w-3 h-3 transition-transform", foldOpen && "rotate-90")} />
              {foldLabel}
            </button>
          )}
          {mayAct && (
            <OrgButton size="sm" className="ml-auto" onClick={() => onAsk(!!undone)} data-org-history-act={undone ? "redo" : "undo"}>
              {undone ? <Redo2 className="w-3 h-3" /> : <Undo2 className="w-3 h-3" />}
              {undone ? "Redo" : "Undo"}
            </OrgButton>
          )}
        </div>
      )}
      {foldOpen && asking === null && <div className="mt-2" data-org-history-rows>{rows}</div>}
      {preview}
    </li>
  );
}

/** One row as its sentence, with what it did beyond its subject under it. */
function RowLine({ row, struck }: { row: OrgLogRow; struck?: boolean }) {
  const effects = orgLogEffectLines(row);
  return (
    <li className="text-[12px] leading-snug" data-org-history-row={row._id}>
      <span className={cn(struck && "line-through decoration-1")} style={{ color: struck ? "var(--sol-text-dim)" : "var(--sol-text-secondary, var(--sol-text-muted))" }}>{orgLogLine(row)}</span>
      {effects.map((line) => (
        <span key={line} className="block pl-3 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-org-history-effect>{line.charAt(0).toUpperCase() + line.slice(1)}</span>
      ))}
    </li>
  );
}

/** The rows behind an entry's fold: the first dozen, then the rest on request.
 *  `rows` undefined is a fold whose rows have not arrived; the entry's own
 *  first row paints meanwhile, so the fold is never empty. */
export function OrgLogRows({ entry, rows }: { entry: OrgLogEntry; rows: OrgLogRow[] | undefined }) {
  const [all, setAll] = useState(false);
  const have = rows && rows.length > 0 ? rows : entry.lead ? [entry.lead] : [];
  const shown = all ? have : have.slice(0, ORG_LOG_FOLD_ROWS);
  const waiting = entry.row_count - have.length;
  return (
    <div className="rounded-lg border px-3 py-2.5" style={{ borderColor: hairline, background: "color-mix(in srgb, var(--sol-card) 60%, transparent)" }}>
      <ul className="space-y-1.5">
        {shown.map((r) => <RowLine key={r._id} row={r} />)}
      </ul>
      {!all && have.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-[11.5px] text-sol-violet hover:underline underline-offset-2" data-org-history-rows-all>
          Show all {have.length}
        </button>
      )}
      {waiting > 0 && rows === undefined && <p className="mt-2 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-org-history-rows-waiting>Reading the other {waiting}</p>}
    </div>
  );
}

function PreviewPart({ name, title, tone, children }: { name: string; title: string; tone?: string; children: ReactNode }) {
  return (
    <section className="border-t pt-2.5 mt-2.5 first:border-t-0 first:pt-0 first:mt-0" style={{ borderColor: hairline }} data-undo-part={name}>
      <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: tone ?? "var(--sol-text-dim)" }}>{title}</h4>
      {children}
    </section>
  );
}

/**
 * Before it happens, the person sees what it will do (S21): each thing that
 * will change back as its sentence, and, stated plainly, what will not: the
 * rows changed since (left alone), the later entries that go with this one or
 * the undo does not happen, and what cannot be taken back at all. `preview`
 * undefined is the server still working; null is a server that cannot say.
 */
export function OrgUndoPreviewCard({ entry, redo, preview, onConfirm, onCancel }: {
  entry: OrgLogEntry;
  redo: boolean;
  preview: OrgUndoPreview | null | undefined;
  onConfirm: (withBatches: string[]) => void;
  onCancel: () => void;
}) {
  const [all, setAll] = useState(false);
  const verb = redo ? "Apply again" : "Take back";
  const refused = preview === null ? "The server could not work out what this would do, so nothing can be changed from here right now." : preview?.refused;
  const will = preview?.will_change ?? [];
  const shown = all ? will : will.slice(0, ORG_LOG_FOLD_ROWS);
  const left = preview?.left_alone ?? [];
  const depends = preview?.depends ?? [];
  const nothing = !!preview && !refused && will.length === 0;

  return (
    <div className="mt-2 rounded-lg border px-3 py-3" style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)", background: "color-mix(in srgb, var(--sol-violet) 6%, var(--sol-card))" }} data-undo-preview={redo ? "redo" : "undo"} role="group" aria-label={`${verb}: ${orgLogEntryLine(entry)}`}>
      {preview === undefined && <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }} data-undo-working>Working out what this will change</p>}
      {refused && <p className="text-[12px] leading-snug" style={{ color: "var(--sol-text-muted)" }} data-undo-refused>{refused}</p>}
      {preview && !refused && (
        <div>
          <PreviewPart name="will-change" title={redo ? "Will be applied again" : "Will change back"}>
            {nothing ? <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Nothing: everything this changed has been changed again since.</p> : (
              <>
                <ul className="space-y-1.5">{shown.map((r) => <RowLine key={r._id} row={r} />)}</ul>
                {!all && will.length > shown.length && (
                  <button type="button" onClick={() => setAll(true)} className="mt-1.5 text-[11.5px] text-sol-violet hover:underline underline-offset-2" data-undo-will-all>Show all {will.length}</button>
                )}
              </>
            )}
          </PreviewPart>
          {left.length > 0 && (
            <PreviewPart name="left-alone" title="Changed since, stays as it is">
              <p className="text-[12px] leading-snug" style={{ color: "var(--sol-text-muted)" }} data-undo-left-line>{sentence(leftAloneLine(left.length, entry.row_count))}.</p>
              <ul className="mt-1.5 space-y-1">
                {left.slice(0, 3).map(({ row, changed_by }) => (
                  <li key={row._id} className="text-[11.5px] leading-snug" style={{ color: "var(--sol-text-dim)" }}>
                    {row.subject.short_id ?? row.subject.label}: {row.skipped ?? "changed after this"}{changed_by ? `, by ${changed_by.name}` : ""}
                  </li>
                ))}
              </ul>
            </PreviewPart>
          )}
          {depends.length > 0 && (
            <PreviewPart name="depends" title={`${depends.length === 1 ? "A later change goes" : "Later changes go"} with it`} tone="var(--sol-yellow)">
              <p className="text-[12px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>
                {depends.length === 1 ? "This later change only makes sense while this one stands." : "These later changes only make sense while this one stands."} They are taken back together, or not at all.
              </p>
              <ul className="mt-1.5 space-y-1">
                {depends.map((d) => <li key={d._id} className="text-[12px] leading-snug" style={{ color: "var(--sol-text-secondary, var(--sol-text-muted))" }} data-undo-depends={d._id}>{orgLogEntryLine(d)}</li>)}
              </ul>
            </PreviewPart>
          )}
          {preview.cannot_take_back.length > 0 && (
            <PreviewPart name="cannot" title="Cannot be taken back">
              <ul className="space-y-1">
                {preview.cannot_take_back.map((c) => <li key={c.kind} className="text-[12px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{orgUndoCannotLine(c)}</li>)}
              </ul>
            </PreviewPart>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <OrgButton size="sm" primary disabled={!preview || !!refused || nothing} onClick={() => onConfirm(depends.map((d) => d.batch))} data-undo-confirm>
          {depends.length > 0 ? `${verb} all ${depends.length + 1}` : verb}
        </OrgButton>
        <OrgButton size="sm" onClick={onCancel} data-undo-cancel>{preview && !refused && !nothing ? "Keep it" : "Close"}</OrgButton>
      </div>
    </div>
  );
}

const sentence = (line: string) => line.charAt(0).toUpperCase() + line.slice(1);

function HistorySkeleton() {
  return (
    <div className="space-y-4" data-org-history-skeleton aria-hidden>
      {[72, 54, 64].map((w, i) => (
        <div key={i} className="pl-[34px] relative">
          <span className="absolute left-0 top-0 w-[22px] h-[22px] rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} />
          <span className="block h-3 rounded" style={{ width: `${w}%`, background: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} />
          <span className="block h-2.5 mt-1.5 rounded w-2/5" style={{ background: "color-mix(in srgb, var(--sol-border) 14%, transparent)" }} />
        </div>
      ))}
    </div>
  );
}
