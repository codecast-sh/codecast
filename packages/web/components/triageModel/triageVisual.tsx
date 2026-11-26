// The triage model's visual half: one mark, one colour and one word per lane,
// ask and reason, drawn with the status vocabulary's own marks so a triaged
// row looks like every other session row in the app.
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { TRIAGE_REASONS, TRIAGE_SHELF_WORDS, type Triage } from "@codecast/shared/contracts/triage";
import { shortDistance, statusOfTriage, textOfTriage } from "../../lib/triage/triageLook";
import { SessionStatusMark } from "../inbox/SessionStatusMark";

export function TriageMark({ triage, size = 10 }: { triage: Triage; size?: number }) {
  return <SessionStatusMark status={statusOfTriage(triage)} size={size} />;
}

/** The reason word, coloured by the kind of act or lane. */
export function ReasonChip({ triage }: { triage: Triage }) {
  return (
    <span data-triage-reason={triage.reason} className={`shrink-0 whitespace-nowrap text-meta font-medium ${textOfTriage(triage)}`}>
      {TRIAGE_REASONS[triage.reason].word}
    </span>
  );
}

/** One line per session: mark, title, reason, wake time, shelf, place, age. */
export function TriageRowView({
  triage,
  title,
  project,
  activityAt,
  now,
  compare,
  actions,
  onOpen,
  onContextMenu,
}: {
  triage: Triage;
  title: string;
  project?: string | null;
  activityAt?: number | null;
  now: number;
  /** Where today's inbox files the row, shown faintly when it differs. */
  compare?: string | null;
  actions?: ReactNode;
  onOpen?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
}) {
  return (
    <div
      data-triage-row={triage.reason}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter") onOpen(); } : undefined}
      onContextMenu={onContextMenu}
      className="group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-sol-bg-alt focus-visible:bg-sol-bg-alt focus-visible:outline-none"
    >
      <TriageMark triage={triage} />
      <span className="min-w-0 flex-1 truncate text-sol-text">{title}</span>
      {triage.surfaced && triage.shelf && (
        <span className="shrink-0 text-mark uppercase tracking-[0.06em] text-sol-text-dim">{TRIAGE_SHELF_WORDS[triage.shelf]}</span>
      )}
      <ReasonChip triage={triage} />
      {triage.until != null && <span className="shrink-0 text-meta tabular-nums text-sol-text-dim">{shortDistance(triage.until, now)}</span>}
      {compare && <span title="Where today's inbox files it" className="shrink-0 text-meta text-sol-text-dim line-through decoration-sol-text-dim/40">{compare}</span>}
      {project && <span className="hidden w-28 shrink-0 truncate text-right text-meta text-sol-text-dim md:block">{project}</span>}
      {actions && <span className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">{actions}</span>}
      {activityAt != null && <span className="w-14 shrink-0 text-right text-meta tabular-nums text-sol-text-dim">{shortDistance(activityAt, now).replace(" ago", "")}</span>}
    </div>
  );
}

export function RowButton({ children, onClick, title }: { children: ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="rounded px-1.5 py-0.5 text-meta text-sol-text-muted hover:bg-sol-border/60 hover:text-sol-text"
    >
      {children}
    </button>
  );
}
