"use client";
// /priorities: the page checked between sessions. The viewer's own active
// priorities in rank order, each with its milestones' states in the session
// language (components/priorities/PriorityBlock; lib/priorityList,
// shared/contracts/priorityDerive), the ones done or set aside folded into one
// line at the bottom, then where the viewer's messages went. The rows come
// from the store (useSyncPriorities feeds convex priorities.list, whose rows
// carry each milestone's sessions and plans); typing per day is an enrichment
// read beside them, and each session's live state is the inbox's own verdict
// when the store holds its row. The list's own width picks the layout: the
// desktop rows down to a Daylight-sized list, the phone layout below it.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronRight, Loader2, Play, Target } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { usePriorities, usePriorityListMeta, usePriorityWrites, useRunPriorities, useSyncPriorities } from "../../hooks/usePriorities";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/button";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame, PageHeader } from "../ui/page-header";
import { LegendButton, Mark } from "../Mark";
import { behindLabel, nextPassLabel, ownerGroups, passDue, type PriorityRow } from "../../lib/priorities";
import { COARSE_TALL, LIST_DAYS, buildModels, lastDays, layoutForWidth, TABLET_QUERY, localDayKey, type ListLayout, type PriorityModel } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { PriorityBlock, type RankDrag } from "./PriorityBlock";
import { MessagesByWorkspace } from "./MessagesByWorkspace";
import { linkedPrRefs, linkedSessionIds, usePriorityLiveStates, usePriorityLookups } from "../../hooks/usePriorityModels";
import { useSidebarFocusId } from "../../hooks/useSidebarFocusId";

const api = _api as any;

export default function PrioritiesPage() {
  const workspace = useActiveWorkspaceKey();
  const feed = useSyncPriorities();
  const rows = usePriorities();
  // Typing per day is computed on read from typed messages (no table to
  // mirror): an enrichment read beside the store, the rows paint without it.
  const history = useQueryNoThrow(
    api.priorities.history,
    workspace ? { workspace, days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : "skip",
    { remember: true },
  ).data as PriorityHistory | undefined;
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
  // The count beside the title is the viewer's own active priorities, the list's rows.
  const listed = useMemo(() => rows.filter((r) => r.mine && r.status === "active").length, [rows]);

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
  } else if (!rows.some((r) => r.mine && r.status !== "merged")) {
    // Teammates' priorities alone draw nothing here: the list is the viewer's own.
    body = <NoPrioritiesYet nextPass={nextPassLabel(meta.next_pass_at, now)} running={pass.running || passDue(meta, now)} onRun={pass.run} />;
  } else {
    body = <PrioritiesView rows={rows} history={history} now={now} layout={layout} />;
  }

  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Priorities" glyph={<Mark id="entity.priority" labeled><Target className="size-4 shrink-0 text-sol-text-muted" aria-hidden /></Mark>} count={rows.length ? listed : null} status={behindChip} actions={<LegendButton lead="Priorities" />} />}
      legacyColumn="mx-auto w-full max-w-[1280px]"
      column="mx-auto w-full max-w-[1280px] px-3 pb-16 sm:px-6"
    >
      <div ref={measure}>{body}</div>
    </PageFrame>
  );
}

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
  // Only the viewer's own: active in rank order, then done, quiet and set aside.
  const own = useMemo(() => ownerGroups(rows).find((g) => g.mine) ?? { active: [], past: [] }, [rows]);
  const shown = useMemo(() => [...own.active, ...own.past], [own]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(shown), [shown]);
  const live = usePriorityLiveStates(ids, now, "sidebar", useSidebarFocusId());
  const models = useMemo(() => buildModels(shown, history, live, days), [shown, history, live, days]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);
  const prs = useMemo(() => linkedPrRefs(shown), [shown]);
  const lookups = usePriorityLookups(ids, prs, useMemo(() => shown.map((r) => r.workspace), [shown]));
  const writes = usePriorityWrites();
  const [pastOpen, setPastOpen] = useState(false);
  // A drag of the viewer's rank on a desktop list: which row, and where it would land.
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);

  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  const activeIds = own.active.map((x) => x.short_id);
  const dragOf = (r: PriorityRow): RankDrag | undefined => {
    if (layout !== "wide" || r.status !== "active") return undefined;
    return {
      dragging: drag?.id === r.short_id,
      accepts: !!drag && drag.id !== r.short_id,
      over: drag && drag.id !== r.short_id && drag.over === r.short_id ? (drag.after ? "after" : "before") : null,
      start: () => setDrag({ id: r.short_id, over: null, after: false }),
      end: () => setDrag(null),
      hover: (after) => setDrag((d) => (d && (d.over !== r.short_id || d.after !== after) ? { ...d, over: r.short_id, after } : d)),
      drop: (after) => {
        if (!drag) return;
        const rest = activeIds.filter((x) => x !== drag.id);
        writes.move(drag.id, rest.indexOf(r.short_id) + (after ? 1 : 0) + 1);
        setDrag(null);
      },
    };
  };
  const block = (r: PriorityRow) => {
    const m: PriorityModel | undefined = byId.get(r.short_id);
    return m && <PriorityBlock key={r.short_id} model={m} layout={layout} days={days} todayIndex={todayIndex} peak={peak} typingPending={!history} now={now} lookups={lookups} drag={dragOf(r)} />;
  };
  return (
    <div data-priorities data-layout={layout} className="[container-type:inline-size]">
      <ol data-active>{own.active.map(block)}</ol>
      {own.past.length > 0 && (
        <div data-past-priorities className="mt-1 border-t border-sol-border/50 pt-2">
          <button
            type="button"
            data-past-toggle
            aria-expanded={pastOpen}
            onClick={() => setPastOpen((o) => !o)}
            className="-ml-1 inline-flex min-h-6 items-center gap-1 rounded px-1 text-mark font-semibold uppercase tracking-wide text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text [@media(pointer:coarse)]:min-h-11"
          >
            Past <span className="font-normal tabular-nums">{own.past.length}</span>
            <ChevronRight className={cn("size-3 transition-transform", pastOpen && "rotate-90")} aria-hidden />
          </button>
          {pastOpen && <ol>{own.past.map(block)}</ol>}
        </div>
      )}
      <MessagesByWorkspace days={days} todayIndex={todayIndex} />
    </div>
  );
}
