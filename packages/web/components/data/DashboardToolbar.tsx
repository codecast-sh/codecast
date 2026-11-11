// The dashboard's controls in the artifact top bar: how fresh its data is
// (click to read everything again now), how many of its numbers are
// verified (click for the list), the view/edit switch, Design and Data
// sources.
import { Database, MousePointer2, Palette, Pencil, RefreshCw } from "lucide-react";
import { dashboard } from "@codecast/shared/artifacts";
import { CheckMark } from "./blocks";

export type PanelKind = "sources" | "design" | "checks" | "check" | "edit";

export type Freshness = { oldest: number; refreshing: boolean; queries: number };

export function DashboardToolbar({
  now,
  freshness,
  counts,
  edit,
  canEdit,
  panel,
  onMode,
  onPanel,
  onRefresh,
}: {
  now: number;
  freshness: Freshness;
  counts: Partial<Record<dashboard.CheckState, number>>;
  edit: boolean;
  canEdit: boolean;
  panel: PanelKind | null;
  onMode: (edit: boolean) => void;
  onPanel: (k: PanelKind) => void;
  onRefresh: () => void;
}) {
  const total = Object.values(counts).reduce((a, n) => a + (n ?? 0), 0);
  const worst: dashboard.CheckState | null = counts.broken ? "broken" : counts.stale || counts.partial ? "stale" : counts.loading || counts.refreshing ? "refreshing" : counts.typed ? "typed" : total ? "verified" : null;
  const label = !freshness.queries
    ? "No data yet"
    : freshness.refreshing
      ? "Refreshing"
      : freshness.oldest
        ? now - freshness.oldest < 45_000
          ? "Updated now"
          : dashboard.ago(now - freshness.oldest)
        : "Reading";
  const summary = worst
    ? worst === "verified"
      ? `All ${counts.verified} numbers verified`
      : [counts.broken && `${counts.broken} can't reproduce`, (counts.stale || counts.partial) && `${(counts.stale ?? 0) + (counts.partial ?? 0)} stale`, counts.typed && `${counts.typed} typed`, counts.verified && `${counts.verified} verified`].filter(Boolean).join(" · ")
    : "";
  return (
    <div className="flex items-center gap-1.5" data-data-toolbar>
      <button type="button" onClick={onRefresh} disabled={!freshness.queries} title={freshness.oldest ? `Updated ${dashboard.ago(now - freshness.oldest)}. Read every source again now` : "Read every source again now"} className="hidden sm:inline-flex items-center gap-1.5 h-7 px-2 rounded-md whitespace-nowrap text-meta text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:hover:bg-transparent" data-freshness>
        <RefreshCw className={`w-3 h-3 ${freshness.refreshing ? "animate-spin" : ""}`} />
        {label}
      </button>
      {worst ? (
        <span className={`inline-flex items-center gap-1 h-7 px-1.5 rounded-md ${panel === "checks" ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-alt"}`} title={summary} data-checks-summary={worst}>
          <CheckMark check={{ state: worst, label: summary }} onClick={() => onPanel("checks")} size={15} />
          <button type="button" onClick={() => onPanel("checks")} className="text-meta tabular-nums text-sol-text-muted hover:text-sol-text whitespace-nowrap">
            {worstLabel(worst, counts)}
          </button>
        </span>
      ) : null}
      {canEdit ? (
        <div className="inline-flex items-center rounded-md bg-sol-bg-alt p-0.5" role="radiogroup" aria-label="Mode">
          <ModeButton on={!edit} onClick={() => onMode(false)} title="View" icon={MousePointer2} />
          <ModeButton on={edit} onClick={() => onMode(true)} title="Edit" icon={Pencil} />
        </div>
      ) : null}
      <BarButton on={panel === "design"} onClick={() => onPanel("design")} title="Design: redo as a story" label="Design" icon={Palette} />
      <BarButton on={panel === "sources"} onClick={() => onPanel("sources")} title="Data sources" label="Sources" icon={Database} />
      <span className="w-px h-4 bg-sol-border/50 mx-0.5" />
    </div>
  );
}

function ModeButton({ on, onClick, title, icon: Icon }: { on: boolean; onClick: () => void; title: string; icon: typeof Pencil }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} title={title} className={`inline-flex items-center justify-center w-7 h-6 rounded ${on ? "bg-sol-bg text-sol-text shadow-sm" : "text-sol-text-dim hover:text-sol-text"}`}>
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

function BarButton({ on, onClick, title, label, icon: Icon }: { on: boolean; onClick: () => void; title: string; label: string; icon: typeof Pencil }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-pressed={on} className={`inline-flex items-center justify-center gap-1.5 h-7 min-w-7 px-1.5 rounded-md text-meta transition-colors ${on ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"}`}>
      <Icon className="w-4 h-4" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

/** The checks in a word: the worst state and how many blocks are in it. */
function worstLabel(worst: dashboard.CheckState, counts: Partial<Record<dashboard.CheckState, number>>): string {
  if (worst === "verified") return "Verified";
  if (worst === "broken") return `${counts.broken} broken`;
  if (worst === "stale") return `${(counts.stale ?? 0) + (counts.partial ?? 0)} stale`;
  if (worst === "refreshing") return `${(counts.loading ?? 0) + (counts.refreshing ?? 0)} reading`;
  return `${counts.typed} unverified`;
}
