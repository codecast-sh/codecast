"use client";
// /initiatives (docs/architecture/initiatives-projects-role-page.md I1): the
// goals the company is trying to reach, by status, each with who drives it,
// how it is going, the number against its target, the next milestone, when it
// is due and how far along it is. Rows, not cards: a person compares
// initiatives, so health and progress each run down a column wherever the
// list is wide enough to give the goal's name its room beside them; narrower,
// the name has a line of its own and the facts wrap under it.
// Paints from the store; progress derives at render from the tasks collection.
import { useMemo, useRef, useState } from "react";
import { ShortId } from "../ShortId";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Flag, Plus } from "lucide-react";
import { INITIATIVE_STATUS_LABEL, metricReadings, metricTrends, milestoneCounts, nextMilestone, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInitiatives, useBoardTasks, useTasksBackfilled } from "../../hooks/useInitiatives";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useWorkspaceArgs, workspaceStamp } from "../../hooks/useWorkspaceArgs";
import { groupInitiativesByStatus, initiativeHref, initiativeProgress, newInitiativeKey, subInitiatives } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { HealthChip, MetricTile, NextMilestoneChip, OwnerChip, ProgressBar, StatusGlyph, TargetDate } from "./InitiativeAtoms";
import { INITIATIVE_ACCENT } from "../../lib/initiativeColors";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const ended = (r: InitiativeRow) => r.status === "completed" || r.status === "cancelled";

// How a row lays out, by the width of the list itself and never the window's:
// the list may sit in a split pane. `stacked` gives the title its own line and
// wraps the facts under it; `columns` runs owner, health, target and progress
// down columns with the number and the next milestone on a second line; `wide`
// gives those two columns of their own. A layout with fixed columns is chosen
// only when the title still gets TITLE_MIN beside them, and there it holds two
// lines, so a goal's name is never cut to a few letters; on its own line it
// reads whole.
type InitiativeListLayout = "stacked" | "columns" | "wide";
const TITLE_MIN = 240;
const GAP = 16;
/** A row's padding and the list's border, which the columns do not get. */
const ROW_CHROME = 34;
const COLUMNS_FIXED = [140, 140, 64, 140]; // owner, health, target, progress
const WIDE_BEFORE = [124, 120, 196]; // owner, health, the number with its name
const WIDE_MILESTONE_FR = 0.6; // the next milestone shares what is left with the title
const WIDE_AFTER = [56, 110]; // target, progress
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const px = (xs: number[]) => xs.map((x) => `${x}px`).join(" ");
const COLUMNS_MIN = ROW_CHROME + TITLE_MIN + sum(COLUMNS_FIXED) + GAP * COLUMNS_FIXED.length;
const WIDE_MIN = ROW_CHROME + TITLE_MIN * (1 + WIDE_MILESTONE_FR) + sum(WIDE_BEFORE) + sum(WIDE_AFTER) + GAP * (WIDE_BEFORE.length + WIDE_AFTER.length + 1);
const initiativeListLayout = (width: number): InitiativeListLayout => (width >= WIDE_MIN ? "wide" : width >= COLUMNS_MIN ? "columns" : "stacked");
const LIST = (layout: InitiativeListLayout) => `[data-initiative-layout="${layout}"]`;
const LAYOUT_CSS = `
  .initiative-grid { display: grid; align-items: center; gap: 6px ${GAP}px; }
  .initiative-facts, .initiative-extra { display: contents; }
  .initiative-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
  .initiative-target-word { display: none; }
  ${LIST("stacked")} .initiative-row { padding-inline: 12px; }
  ${LIST("stacked")} .initiative-grid { grid-template-columns: minmax(0,1fr); }
  ${LIST("stacked")} .initiative-title { display: block; overflow: visible; }
  ${LIST("stacked")} .initiative-target-word { display: inline; }
  ${LIST("stacked")} .initiative-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; padding-left: 24px; }
  ${LIST("stacked")} .initiative-facts[data-nested] { padding-left: 44px; }
  ${LIST("stacked")} .initiative-facts > *, ${LIST("stacked")} .initiative-extra > * { min-width: 0; max-width: 100%; }
  ${LIST("stacked")} .initiative-facts > :empty, ${LIST("stacked")} .initiative-extra > :empty { display: none; }
  ${LIST("stacked")} .initiative-facts > [data-initiative-progress] { flex: 1 1 160px; max-width: 280px; }
  ${LIST("columns")} .initiative-grid { grid-template-columns: minmax(0,1fr) ${px(COLUMNS_FIXED)}; }
  ${LIST("columns")} .initiative-extra { display: flex; grid-column: 1 / -1; grid-row: 2; align-items: center; column-gap: ${GAP}px; min-width: 0; padding-left: 24px; }
  ${LIST("columns")} .initiative-extra[data-empty] { display: none; }
  ${LIST("columns")} .initiative-extra[data-nested] { padding-left: 44px; }
  ${LIST("wide")} .initiative-grid { grid-template-columns: minmax(0,1fr) ${px(WIDE_BEFORE)} minmax(0,${WIDE_MILESTONE_FR}fr) ${px(WIDE_AFTER)}; }
`;

export function InitiativesList() {
  // An owner may be a role: the chips read the org roles, so keep them fed.
  useSyncOrgTreeFeeder();
  const rows = useInitiatives();
  const tasks = useBoardTasks();
  const counted = useTasksBackfilled();
  const now = useCoarseNow(60_000);
  const phone = useIsPhone();
  const groups = useMemo(() => groupInitiativesByStatus(rows), [rows]);
  const [creating, setCreating] = useState(false);
  // The rows' own width. Before it is measured (and in a DOM that lays
  // nothing out) the window's width, less the page's padding, stands in.
  const measureRef = useRef<HTMLDivElement>(null);
  const guess = () => initiativeListLayout(typeof window === "undefined" ? WIDE_MIN : window.innerWidth - (phone ? 24 : 64));
  const layout = useDerivedSize(measureRef, (w) => (w > 0 ? initiativeListLayout(w) : guess()), guess);

  return (
    <div className="h-full overflow-y-auto" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-initiatives-list>
      <style>{`
        @keyframes initiative-rise { from { opacity: 0; transform: translateY(5px); } }
        .initiative-row { animation: initiative-rise .26s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .initiative-row { animation: none; } }
        ${LAYOUT_CSS}
      `}</style>
      <div className={cn("mx-auto w-full max-w-[1240px]", phone ? "px-3 pt-4 pb-10" : "px-8 pt-8 pb-16")}>
        <div ref={measureRef} data-initiative-layout={layout}>
          {/* The sentence has the full width under the title, so the controls never squeeze it into a column. */}
          <header>
            <div className="flex items-center justify-between gap-4">
              <h1 className={cn("min-w-0 font-semibold tracking-tight leading-none", phone ? "text-[20px]" : "text-[26px]")} style={{ fontFamily: "var(--font-serif)" }}>Initiatives</h1>
              <div className="flex shrink-0 items-center gap-3">
                {/* The same goals as one page to read top to bottom, with their projects, roles and people. */}
                <Link href="/company" className="inline-flex items-center gap-1.5 text-[12.5px] no-underline hover:underline" style={{ color: "var(--sol-text-muted)" }} data-initiatives-document><FileText className="w-3.5 h-3.5" /> {layout === "stacked" ? "Document" : "Read as a document"}</Link>
                {!creating && rows.length > 0 && <NewButton onClick={() => setCreating(true)} />}
              </div>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed max-w-[60ch]" style={{ color: "var(--sol-text-muted)" }}>
              What the company is trying to reach. Each one names the projects that carry it and one owner who drives it.
            </p>
          </header>

          {creating && <CreateInitiative onDone={() => setCreating(false)} />}

          {rows.length === 0 && !creating ? (
            <EmptyState onCreate={() => setCreating(true)} />
          ) : (
            <div className="mt-7 space-y-7">
              {groups.map((g) => (
                <section key={g.status} data-initiative-group={g.status}>
                  <h2 className="flex items-center gap-2 px-1 mb-2 text-[12.5px] font-medium" style={{ color: "var(--sol-text-secondary)" }}>
                    <StatusGlyph status={g.status} />
                    {INITIATIVE_STATUS_LABEL[g.status]}
                    <span className="tabular-nums font-normal" style={{ color: "var(--sol-text-dim)" }}>{g.rows.length}</span>
                  </h2>
                  <div className="rounded-xl border overflow-hidden" style={{ borderColor: HAIRLINE }}>
                    {g.rows.flatMap((r, i) => [
                      <Row key={r._id} row={r} index={i} now={now} progress={initiativeProgress(r, tasks)} partial={!counted} />,
                      ...subInitiatives(rows, r._id).map((sub) => (
                        <Row key={sub._id} row={sub} index={i} now={now} progress={initiativeProgress(sub, tasks)} partial={!counted} nested />
                      )),
                    ])}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One DOM for every layout: the list's layout attribute lays it out (LAYOUT_CSS). */
function Row({ row, index, now, progress, partial, nested }: { row: InitiativeRow; index: number; now: number; progress: ReturnType<typeof initiativeProgress>; partial: boolean; nested?: boolean }) {
  const projects = row.project_ids.length;
  // The first number is the one a list has room for; the page shows both.
  const reading = metricReadings(row)[0];
  const metric = reading ? <MetricTile reading={reading} trend={metricTrends(row)[reading.key]} now={now} size="chip" /> : null;
  const next = nextMilestone(row);
  const counts = milestoneCounts(row);
  const milestone = next || counts.total ? <NextMilestoneChip milestone={next} now={now} counts={counts} /> : null;
  return (
    <Link
      href={initiativeHref(row)}
      className="initiative-row group block no-underline border-t first:border-t-0 px-4 py-3 transition-colors hover:bg-sol-bg-highlight/50 focus-visible:outline-none focus-visible:bg-sol-bg-highlight/60"
      style={{ borderColor: HAIRLINE, animationDelay: `${Math.min(index, 8) * 28}ms`, opacity: ended(row) ? 0.72 : 1 }}
      data-initiative-row={row.short_id || row._id}
      data-initiative-nested={nested ? "1" : undefined}
    >
      <div className="initiative-grid">
        <div className={cn("min-w-0 flex items-center gap-2.5", nested && "pl-5")}>
          {nested ? <span className="w-3 h-px shrink-0" style={{ background: "var(--sol-text-dim)" }} aria-hidden /> : <Flag className="w-3.5 h-3.5 shrink-0" style={{ color: ended(row) ? "var(--sol-text-dim)" : INITIATIVE_ACCENT }} />}
          {/* The title owns the column; the id and the project count sit under it. */}
          <span className="min-w-0 flex-1 flex flex-col">
            <span className="initiative-title text-[13.5px] font-medium" style={{ color: "var(--sol-text)" }} title={row.title} data-initiative-row-title>{row.title}</span>
            <span className="flex items-center gap-2 min-w-0">
              <ShortId id={row.short_id} className="text-[10.5px]" style={{ color: "var(--sol-text-dim)" }} />
              {!nested && <span className="truncate text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{projects === 0 ? "no projects" : `${projects} ${projects === 1 ? "project" : "projects"}`}</span>}
            </span>
          </span>
        </div>
        <div className="initiative-facts" data-nested={nested ? "" : undefined}>
          <OwnerChip owner={row.owner} />
          <HealthChip health={row.health} at={row.health_at} now={now} />
          {/* Always two cells, so a goal with no number keeps the columns after it in line. */}
          <span className="initiative-extra" data-empty={metric || milestone ? undefined : ""} data-nested={nested ? "" : undefined}>
            <span className="min-w-0 inline-flex" data-initiative-row-metric>{metric}</span>
            <span className="min-w-0 inline-flex" data-initiative-row-milestone>{milestone}</span>
          </span>
          {/* A column says what the day is by where it stands; in a wrapped line the word does. */}
          <span className="text-right whitespace-nowrap">{row.target_date ? <><span className="initiative-target-word text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>due </span><TargetDate ts={row.target_date} now={now} done={ended(row)} /></> : null}</span>
          <ProgressBar progress={progress} partial={partial} />
        </div>
      </div>
    </Link>
  );
}

function NewButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 h-[32px] inline-flex items-center gap-1.5 px-3 rounded-lg text-[12.5px] font-medium hover:brightness-110 transition-[filter]" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }} data-initiative-new>
      <Plus className="w-3.5 h-3.5" /> New initiative
    </button>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-16 mx-auto max-w-md text-center" data-initiatives-empty>
      <span className="mx-auto w-11 h-11 rounded-full inline-flex items-center justify-center" style={{ background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 12%, transparent)`, color: INITIATIVE_ACCENT }}><Flag className="w-5 h-5" /></span>
      <h2 className="mt-4 text-[17px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)" }}>No initiatives yet</h2>
      <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
        An initiative is a goal above your projects: what you are trying to reach, which projects carry it, who drives it, and how it is going.
      </p>
      <div className="mt-5 flex justify-center"><NewButton onClick={onCreate} /></div>
    </div>
  );
}

/** One field: the title. The row appears in the list in the same tick, owned
 *  by the person who made it, and its page is where the rest is said. */
function CreateInitiative({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const router = useRouter();
  const workspaceArgs = useWorkspaceArgs();
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const me = s.currentUser?._id ? String(s.currentUser._id) : null;
  const ready = workspaceArgs !== "skip" && !!me;
  const submit = () => {
    const clean = title.trim();
    if (!clean || workspaceArgs === "skip" || !me) return;
    const client_key = newInitiativeKey();
    useInboxStore.getState().createInitiative({ client_key, title: clean, owner: { kind: "user", user_id: me }, ...(workspaceStamp(workspaceArgs) as { workspace: "personal" | "team"; team_id?: string }) });
    onDone();
    router.push(`/initiatives/${client_key}`);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-6 flex items-center gap-2 rounded-xl border px-3 py-2" style={{ borderColor: `color-mix(in srgb, ${INITIATIVE_ACCENT} 45%, transparent)` }} data-initiative-create>
      <Flag className="w-3.5 h-3.5 shrink-0" style={{ color: INITIATIVE_ACCENT }} />
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}
        placeholder="What are you trying to reach?"
        className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] placeholder:text-sol-text-dim"
        aria-label="Initiative title"
      />
      <button type="button" onClick={onDone} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
      <button type="submit" disabled={!title.trim() || !ready} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }}>Create</button>
    </form>
  );
}
