"use client";
// /priorities: the page checked between sessions. Every priority the viewer
// can read, in every workspace they hold, each with its milestones' states in
// the session language (components/priorities/PriorityBlock; lib/priorityList,
// shared/contracts/priorityDerive), grouped as the viewer chooses
// (lib/prioritySections, components/priorities/PrioritySections), then where
// the viewer's messages went. The rows come from the store (useSyncPriorities
// feeds convex priorities.list, whose rows carry each milestone's sessions
// and plans); typing per day is an enrichment read beside them, and each
// session's live state is the inbox's own verdict when the store holds its
// row. The list's own width picks the layout: the desktop rows down to a
// Daylight-sized list, the phone layout below it.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, Play, Target } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { usePriorities, usePriorityListMeta, usePrioritiesView, usePriorityWrites, useRunPriorities, useSyncPriorities } from "../../hooks/usePriorities";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/button";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame, PageHeader } from "../ui/page-header";
import { LegendButton, Mark } from "../Mark";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import { useServerAuthSettled } from "../../hooks/useServerAuthSettled";
import { useInboxStore } from "../../store/inboxStore";
import { behindLabel, nextPassLabel, passDue, type PriorityRow } from "../../lib/priorities";
import { buildSections, pageControls, rankDraggable, visibleCount, type Sections } from "../../lib/prioritySections";
import { PrioritiesToolbar } from "./PrioritiesToolbar";
import { OwnerFace, PrioritySections, type BlockOf } from "./PrioritySections";
import { COARSE_TALL, LIST_DAYS, buildModels, lastDays, layoutForWidth, TABLET_QUERY, localDayKey, type ListLayout, type PriorityModel } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { PriorityBlock, type RankDrag } from "./PriorityBlock";
import { MessagesByWorkspace } from "./MessagesByWorkspace";
import { linkedPrRefs, linkedSessionIds, usePriorityLiveStates, usePriorityLookups } from "../../hooks/usePriorityModels";
import { useSidebarFocusId } from "../../hooks/useSidebarFocusId";

const api = _api as any;

export default function PrioritiesPage() {
  const feed = useSyncPriorities();
  const rows = usePriorities();
  // Typing per day, every workspace's in one answer, is computed on read from
  // typed messages (no table to mirror): an enrichment read beside the store,
  // the rows paint without it.
  const settled = useServerAuthSettled();
  const history = useQueryNoThrow(
    api.priorities.history,
    settled ? { days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : "skip",
    { remember: true },
  ).data as PriorityHistory | undefined;
  const [view] = usePrioritiesView();
  const meta = usePriorityListMeta();
  const pass = useRunPriorities(rows.length);
  const now = useCoarseNow(30_000);
  const behind = behindLabel(meta.behind_by_ms);

  const [measure, layout] = useListLayout();

  const behindChip = behind ? <BehindChip label={behind} /> : undefined;
  const legacy = (
    <header className="flex items-center gap-2 px-4 pt-6">
      <h1 className="flex items-center gap-2 text-title font-semibold text-sol-text">Priorities{behindChip}</h1>
      <span className="ml-auto"><LegendButton lead="Priorities" /></span>
    </header>
  );
  // The count beside the title is everyone's active priorities in the sections shown.
  const listed = useMemo(() => visibleCount(rows, view.hidden), [rows, view.hidden]);

  let body: ReactNode;
  if (rows.length === 0 && feed.error) {
    body = (
      <EmptyState icon={AlertTriangle} title="Priorities didn't load" action={{ label: "Try again", onClick: feed.retry }}>
        <details className="max-w-md text-meta text-sol-text-dim">
          <summary className="cursor-pointer [@media(pointer:coarse)]:flex [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:items-center">Details</summary>
          <p className="mt-1 break-words">{feed.error.message}</p>
        </details>
      </EmptyState>
    );
  } else if (rows.length === 0 && !feed.ready) {
    body = <SkeletonRows rows={6} className="pt-2" rowClassName="h-8" />;
  } else if (!rows.some((r) => r.status !== "merged")) {
    body = <NoPrioritiesYet nextPass={nextPassLabel(meta.next_pass_at, now)} running={pass.running || passDue(meta, now)} onRun={pass.run} />;
  } else {
    body = <PrioritiesView rows={rows} history={history} now={now} layout={layout} />;
  }

  // The header's row sits in the list's column: the same max width, centred, its edges on the list's.
  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Priorities" glyph={<Mark id="entity.priority" labeled><Target className="size-4 shrink-0 text-sol-text-muted" aria-hidden /></Mark>} count={rows.length ? listed : null} status={behindChip} actions={<LegendButton lead="Priorities" />} className={HEAD_IN_COLUMN} />}
      legacyColumn={LIST_COLUMN}
      column="w-full pb-16 [container-type:inline-size]"
    >
      {/* The header row's own padding: 16px, 24px once the pane is 640px wide (components/ui/page-header.css). */}
      <div className={cn(LIST_COLUMN, "px-4 [@container(min-width:640px)]:px-6")}>
        <div ref={measure}>{body}</div>
      </div>
    </PageFrame>
  );
}

const LIST_COLUMN = "mx-auto w-full max-w-[1280px]";
/** The header bar's first row (components/ui/page-header) held to the list's column. */
const HEAD_IN_COLUMN = "[&>div:first-child]:mx-auto [&>div:first-child]:w-full [&>div:first-child]:max-w-[1280px]";

/** A touch screen at least 900px wide: Daylight gets the desktop grid whatever its sidebars leave the list. */
const isTablet = () => typeof window !== "undefined" && !!window.matchMedia?.(TABLET_QUERY).matches;

/**
 * The layout for the list's own width and the screen (lib/priorityList
 * layoutForWidth), first guessed from the window and then measured,
 * re-rendering only when the layout flips.
 */
function useListLayout(): [(el: HTMLDivElement | null) => void, ListLayout] {
  const [layout, setLayout] = useState<ListLayout>(() => layoutForWidth(typeof window === "undefined" ? 1280 : window.innerWidth, isTablet()));
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => setLayout(layoutForWidth(entry.contentRect.width, isTablet())));
    observer.current.observe(el);
  }, []);
  useMountEffect(() => () => observer.current?.disconnect());
  return [measure, layout];
}

/** The pass has fallen behind its schedule: priorities may miss the newest sessions. */
export function BehindChip({ label }: { label: string }) {
  return (
    <span
      data-priorities-behind
      title="The priorities pass has run late: the newest sessions may not be in these priorities yet."
      className="inline-flex shrink-0 items-center rounded-full border border-sol-yellow/40 bg-sol-yellow/10 px-2 py-0.5 text-meta font-medium text-sol-yellow"
    >
      {label}
    </span>
  );
}

/** A one-time act that starts a model run: reviewed before it starts (components/consequential). */
const RUN_LEDGER: SwitchLedger = {
  name: "Run a pass now",
  subject: "Your priorities in this workspace",
  shift: null,
  figures: [{ value: "1", label: "model run" }],
  rows: [
    { k: "Reads", v: "Your sessions and typed messages" },
    { k: "Writes", v: "Your priorities here" },
    { k: "Keeps", v: "Your ranks, tiers and set-asides" },
  ],
  confirm: "Run now",
  keep: "Not now",
};

/** No priorities yet: when the next pass runs, and a pass now. */
export function NoPrioritiesYet({ nextPass, running, onRun }: { nextPass: string | null; running: boolean; onRun: (() => void) | null }) {
  const [reviewing, setReviewing] = useState(false);
  const action = running ? (
    <Button size="sm" variant="secondary" disabled data-priorities-running className={COARSE_TALL}>
      <Loader2 className="animate-spin" /> Running
    </Button>
  ) : onRun ? (
    <Button size="sm" variant="primary" onClick={() => setReviewing(true)} className={COARSE_TALL}>
      <Play /> Run now
    </Button>
  ) : undefined;
  return (
    <EmptyState icon={Target} title="No priorities yet" action={action}>
      {nextPass && !running && <p data-next-pass className="text-meta tabular-nums text-sol-text-dim">{nextPass}</p>}
      {reviewing && onRun && (
        <SwitchReview ledger={RUN_LEDGER} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); onRun(); }} />
      )}
    </EmptyState>
  );
}

export function PrioritiesView({ rows, history, now, layout }: {
  rows: PriorityRow[];
  history: PriorityHistory | undefined;
  now: number;
  layout: ListLayout;
}) {
  const [view, setView] = usePrioritiesView();
  const activeWorkspace = useActiveWorkspaceKey();
  const teams = useInboxStore((s) => s.teams);
  const workspaceNames = useMemo(() => Object.fromEntries((teams ?? []).map((t: any) => [`team:${t._id}`, String(t.name ?? "Team")])), [teams]);
  const opts = useMemo(() => ({ activeWorkspace, hidden: view.hidden, workspaceNames }), [activeWorkspace, view.hidden, workspaceNames]);
  const controls = useMemo(() => pageControls(rows, opts), [rows, opts]);
  const sections = useMemo(() => buildSections(rows, { ...opts, groupBy: view.groupBy }), [rows, opts, view.groupBy]);
  // Every row the sections draw, open or folded: their models share one scale.
  const shown = useMemo(() => sectionRows(sections), [sections]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(shown), [shown]);
  const live = usePriorityLiveStates(ids, now, "sidebar", useSidebarFocusId());
  const models = useMemo(() => buildModels(shown, history, live, days), [shown, history, live, days]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);
  const prs = useMemo(() => linkedPrRefs(shown), [shown]);
  const lookups = usePriorityLookups(ids, prs, useMemo(() => shown.map((r) => r.workspace), [shown]));
  const writes = usePriorityWrites();
  // A drag of the viewer's rank on a desktop list: which row (in which workspace), and where it would land.
  const [drag, setDrag] = useState<{ id: string; workspace: string; over: string | null; after: boolean } | null>(null);

  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  const dragOf = (r: PriorityRow): RankDrag | undefined => {
    if (layout !== "wide" || !rankDraggable(sections.groupBy, r)) return undefined;
    // A drop lands only among the viewer's priorities in the dragged one's workspace.
    const peer = !!drag && drag.id !== r.short_id && drag.workspace === r.workspace;
    return {
      dragging: drag?.id === r.short_id,
      accepts: peer,
      over: peer && drag.over === r.short_id ? (drag.after ? "after" : "before") : null,
      start: () => setDrag({ id: r.short_id, workspace: r.workspace, over: null, after: false }),
      end: () => setDrag(null),
      hover: (after) => setDrag((d) => (d && (d.over !== r.short_id || d.after !== after) ? { ...d, over: r.short_id, after } : d)),
      drop: (after) => {
        if (!drag) return;
        const rest = effectivePriorityOrder(rows.filter((x) => x.mine && x.workspace === r.workspace)).map((x) => x.short_id).filter((x) => x !== drag.id);
        writes.move(drag.id, rest.indexOf(r.short_id) + (after ? 1 : 0) + 1);
        setDrag(null);
      },
    };
  };
  const block: BlockOf = (r, o) => {
    const m: PriorityModel | undefined = byId.get(r.short_id);
    return m && (
      <PriorityBlock
        key={r.short_id}
        model={m}
        layout={layout}
        days={days}
        todayIndex={todayIndex}
        peak={peak}
        typingPending={!history}
        now={now}
        lookups={lookups}
        drag={dragOf(r)}
        compact={view.compact}
        face={o?.face ? <OwnerFace row={r} /> : undefined}
      />
    );
  };
  return (
    <div data-priorities data-layout={layout} data-group-by={sections.groupBy} data-compact={view.compact || undefined} className="[container-type:inline-size]">
      <PrioritiesToolbar controls={controls} view={view} groupBy={sections.groupBy} onChange={setView} layout={layout} />
      <PrioritySections sections={sections} block={block} layout={layout} headings={controls.showSectionHeadings} people={controls.showGroupBy} />
      <MessagesByWorkspace days={days} todayIndex={todayIndex} />
    </div>
  );
}

/** Every priority the sections draw, active and folded. */
function sectionRows(sections: Sections): PriorityRow[] {
  if (sections.groupBy === "workspace") return sections.sections.flatMap((s) => [...s.active.map((x) => x.row), ...s.past]);
  if (sections.groupBy === "person_workspace") return sections.sections.flatMap((p) => p.workspaces.flatMap((w) => [...w.active, ...w.past]));
  return sections.sections.flatMap((s) => s.people.flatMap((p) => [...p.active, ...p.past]));
}
