"use client";
// /priorities: the page checked between sessions. One line of stats (critical
// milestones landed in ten days, where today's messages went), the filters
// (Mine, Hide done, which links to Show; kept in the address, and a bare
// address opens the viewer's last ones: lib/rememberedFilters), what waits on
// the person, then each priority with its one next action (lib/priorityList,
// shared/contracts/priorityDerive). The rows come from the store
// (useSyncPriorities feeds convex priorities.list, whose rows carry each
// milestone's sessions and plans); typing per day is an enrichment read
// beside them, and each session's live state is the inbox's own verdict when
// the store holds its row. A compact view, kept per viewer, folds each
// priority to one line. The list's own width picks the layout: the desktop
// grid down to a Daylight-sized list, the phone layout below it.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Check, ChevronDown, Loader2, Play, Rows3, Target } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory, PriorityMergeProposal } from "@codecast/shared/contracts/priorities";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { usePriorities, usePriorityListMeta, usePriorityProposals, usePriorityWrites, useRunPriorities, useSyncPriorities } from "../../hooks/usePriorities";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/button";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame, PageHeader } from "../ui/page-header";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { behindLabel, nextPassLabel, ownerGroups, passDue, type OwnerGroup, type PriorityRow } from "../../lib/priorities";
import {
  COARSE_TALL, FILTER_PARAMS, LIST_DAYS, LIST_GRID, POLISH_SLOT, SHOW_KINDS, TOUCH_AREA, buildModels, filterParams, filtersHref, landedByDay, lastDays, layoutForWidth, listedRows, TABLET_QUERY, localDayKey, readFilters, todayOf, waitingOf,
  type ListFilters, type ListLayout, type PriorityModel, type ShowKind,
} from "../../lib/priorityList";
import { useInboxStore, type ClientUI } from "../../store/inboxStore";
import { rememberFilters, useRememberedFilters } from "../../lib/rememberedFilters";
import { cn } from "../../lib/utils";
import { PriorityBlock, type RankDrag } from "./PriorityBlock";
import { linkedPrRefs, linkedSessionIds, usePriorityLiveStates, usePriorityLookups } from "../../hooks/usePriorityModels";
import { StatsLine } from "./StatsLine";
import { WaitingOnYou } from "./Waiting";
import { MergeProposals, proposalMarks } from "./Proposals";

const api = _api as any;

/** The compact view rides the ui prefs bag, so it follows the viewer to every device. */
type CompactPrefs = { priorities_view?: { compact?: boolean } };

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
  const proposals = usePriorityProposals();
  const pass = useRunPriorities(rows.length);
  const now = useCoarseNow(30_000);
  const behind = behindLabel(meta.behind_by_ms);

  const router = useRouter();
  const params = useSearchParams();
  // An address that names no filter opens the ones the viewer last chose here (lib/rememberedFilters).
  const opened = useRememberedFilters("priorities", FILTER_PARAMS, params);
  const filters = useMemo(() => readFilters(opened), [opened]);
  const setFilters = useCallback((f: ListFilters) => {
    rememberFilters("priorities", filterParams(f));
    router.replace(filtersHref(f, params));
  }, [router, params]);
  const compact = useInboxStore((s) => !!(s.clientState.ui as CompactPrefs | undefined)?.priorities_view?.compact);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const setCompact = useCallback((on: boolean) => updateClientUI({ priorities_view: { compact: on } } as Partial<ClientUI>), [updateClientUI]);
  const [measure, layout] = useListLayout();

  const behindChip = behind ? <BehindChip label={behind} /> : undefined;
  const legacy = <h1 className="flex items-center gap-2 px-4 pt-6 text-title font-semibold text-sol-text">Priorities{behindChip}</h1>;
  // The count beside the title is what the list below it draws.
  const listed = useMemo(() => listedRows(rows, filters).length, [rows, filters]);

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
  } else if (rows.length === 0) {
    body = <NoPrioritiesYet nextPass={nextPassLabel(meta.next_pass_at, now)} running={pass.running || passDue(meta, now)} onRun={pass.run} />;
  } else {
    body = <PrioritiesView rows={rows} history={history} now={now} layout={layout} filters={filters} onFilters={setFilters} compact={compact} onCompact={setCompact} proposals={proposals} />;
  }

  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Priorities" icon={Target} count={rows.length ? listed : null} status={behindChip} />}
      // The side padding is the gutter a wide list's ⋯ menus sit in (PriorityBlock C_MENU), 32px: from 544px a list can be wide (520px).
      // Classic's shell pads 24px at sm and 32px from lg.
      legacyColumn="mx-auto w-full max-w-[1280px] min-[544px]:px-4 min-[640px]:px-2 min-[1024px]:px-0"
      column="mx-auto w-full max-w-[1280px] px-3 pb-16 pt-3 min-[544px]:px-10"
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

export function PrioritiesView({ rows, history, now, layout, filters, onFilters, compact, onCompact, proposals = [] }: {
  rows: PriorityRow[];
  history: PriorityHistory | undefined;
  now: number;
  layout: ListLayout;
  filters: ListFilters;
  onFilters: (f: ListFilters) => void;
  compact: boolean;
  onCompact: (on: boolean) => void;
  /** The viewer's merge proposals waiting on them (usePriorityProposals). */
  proposals?: PriorityMergeProposal[];
}) {
  const marks = useMemo(() => proposalMarks(proposals), [proposals]);
  const scoped = useMemo(() => rows.filter((r) => r.status !== "merged" && (!filters.mine || r.mine)), [rows, filters.mine]);
  const visible = useMemo(() => listedRows(rows, filters), [rows, filters]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(visible), [visible]);
  const live = usePriorityLiveStates(ids, now);
  const models = useMemo(() => buildModels(visible, history, live, days, now), [visible, history, live, days, now]);
  const waiting = useMemo(() => waitingOf(models), [models]);
  const landed = useMemo(() => landedByDay(scoped, days), [scoped, days]);
  const today = useMemo(() => todayOf(history, rows, now), [history, rows, now]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);

  const prs = useMemo(() => linkedPrRefs(visible), [visible]);
  const lookups = usePriorityLookups(ids, prs);
  const writes = usePriorityWrites();
  // A drag of the viewer's rank on a desktop list: which row, and where it would land.
  const [drag, setDrag] = useState<{ id: string; over: string | null; after: boolean } | null>(null);

  const groups = ownerGroups(visible);
  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  const dragOf = (g: OwnerGroup, r: PriorityRow): RankDrag | undefined => {
    if (layout !== "wide" || !g.mine || r.status !== "active") return undefined;
    const ids = g.active.map((x) => x.short_id);
    const ours = !!drag && ids.includes(drag.id);
    return {
      dragging: drag?.id === r.short_id,
      accepts: ours && drag!.id !== r.short_id,
      over: ours && drag!.id !== r.short_id && drag!.over === r.short_id ? (drag!.after ? "after" : "before") : null,
      start: () => setDrag({ id: r.short_id, over: null, after: false }),
      end: () => setDrag(null),
      hover: (after) => setDrag((d) => (d && (d.over !== r.short_id || d.after !== after) ? { ...d, over: r.short_id, after } : d)),
      drop: (after) => {
        if (!drag) return;
        const rest = ids.filter((x) => x !== drag.id);
        writes.move(drag.id, rest.indexOf(r.short_id) + (after ? 1 : 0) + 1);
        setDrag(null);
      },
    };
  };
  const block = (m: PriorityModel | undefined, g: OwnerGroup) => m && (
    <PriorityBlock key={m.row.short_id} model={m} layout={layout} compact={compact} filters={filters} todayIndex={todayIndex} peak={peak} now={now} lookups={lookups} drag={dragOf(g, m.row)} merge={m.row.mine ? marks.get(m.row.short_id) : undefined} />
  );
  return (
    <div data-priorities data-layout={layout} data-compact={compact || undefined} className="[container-type:inline-size]">
      <StatsLine days={days} landed={landed} todayIndex={todayIndex} today={today} loose={history?.unassigned_today ?? []} now={now} layout={layout} />
      <FilterBar filters={filters} onChange={onFilters} compact={compact} onCompact={onCompact} layout={layout} />
      {filters.mine && <WaitingOnYou items={waiting} now={now} layout={layout} />}
      <MergeProposals proposals={proposals} layout={layout} />
      {layout === "wide" && (
        <div aria-hidden className={cn(LIST_GRID.wide, "border-b border-sol-border/50 pb-1 text-mark font-medium uppercase tracking-wide text-sol-text-dim")}>
          <span className="col-start-3 flex w-full justify-end gap-2"><span className="px-1">Critical</span><span className={cn(POLISH_SLOT, compact && "[@container(max-width:44rem)]:hidden")} /></span>
          <span className="col-start-4 justify-self-center">Today</span>
          <span className="col-start-5">10 days</span>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.user_id} data-owner={g.user_id} className={cn(!filters.mine && "mb-6")}>
          {!filters.mine && <h2 className="mb-1 border-b border-sol-border/60 pb-1.5 pt-2 text-ui font-semibold text-sol-text">{g.mine ? "You" : g.owner || "Teammate"}</h2>}
          <ol>{[...g.active, ...g.past].map((r) => block(byId.get(r.short_id), g))}</ol>
        </section>
      ))}
    </div>
  );
}

const SHOW_LABELS: Record<ShowKind, string> = { sessions: "Sessions", plans: "Plans", tasks: "Tasks", prs: "PRs", branches: "Branches", deploys: "Deploys" };

/** Which priorities: two quiet segments, set apart from the Show chips. */
function Segment({ on, onClick, children, tall, ...rest }: { on: boolean; onClick: () => void; children: ReactNode; tall?: boolean } & Record<`data-${string}`, string>) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      {...rest}
      className={cn("inline-flex items-center gap-1 rounded-[5px] px-2.5 text-meta transition-colors", tall ? "h-11" : cn("h-7 [@media(pointer:coarse)]:h-11", TOUCH_AREA), on ? "bg-sol-card font-medium text-sol-text shadow-sm" : "text-sol-text-dim hover:text-sol-text")}
    >
      {on && <Check className="size-3" strokeWidth={2.5} />}
      {children}
    </button>
  );
}

function FilterBar({ filters, onChange, compact, onCompact, layout }: { filters: ListFilters; onChange: (f: ListFilters) => void; compact: boolean; onCompact: (on: boolean) => void; layout: ListLayout }) {
  const toggleShow = (k: ShowKind) => onChange({ ...filters, show: { ...filters.show, [k]: !filters.show[k] } });
  const shown = SHOW_KINDS.filter((k) => filters.show[k]).length;
  const wide = layout === "wide";
  return (
    // Wraps rather than clips: on a narrow list (Daylight beside the inbox) Compact goes to a second line. Under a coarse
    // pointer the segments are 44px themselves and wrapped rows sit 16px apart, so no two press areas overlap.
    <div data-filters className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 [@media(pointer:coarse)]:gap-y-4">
      <div className="inline-flex shrink-0 gap-0.5 rounded-[7px] bg-sol-text/[0.06] p-0.5">
        <Segment data-filter="mine" on={filters.mine} onClick={() => onChange({ ...filters, mine: !filters.mine })} tall={!wide}>Mine</Segment>
        <Segment data-filter="done" on={filters.hideDone} onClick={() => onChange({ ...filters, hideDone: !filters.hideDone })} tall={!wide}>Hide done</Segment>
      </div>
      {wide ? (
        <div data-show-chips className="flex items-center gap-0.5">
          <span className="mr-1 text-meta text-sol-text-dim">Show</span>
          {SHOW_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              data-show={k}
              aria-pressed={filters.show[k]}
              onClick={() => toggleShow(k)}
              className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-meta transition-colors", TOUCH_AREA, filters.show[k] ? "border-sol-text-muted/60 text-sol-text" : "border-transparent text-sol-text-dim hover:border-sol-border")}
            >
              {filters.show[k] && <Check className="size-3" strokeWidth={2.5} />}
              {SHOW_LABELS[k]}
            </button>
          ))}
        </div>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" data-show-menu className="ml-auto inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-control px-2.5 text-ui text-sol-text-muted hover:bg-sol-bg-alt">
              Show <span className="tabular-nums text-sol-text-dim">{shown}</span> <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {SHOW_KINDS.map((k) => (
              <DropdownMenuCheckboxItem key={k} checked={filters.show[k]} onSelect={(e) => e.preventDefault()} onCheckedChange={() => toggleShow(k)}>{SHOW_LABELS[k]}</DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        data-compact-toggle
        aria-pressed={compact}
        aria-label="Compact"
        title={compact ? "One line per milestone" : "One line per priority"}
        onClick={() => onCompact(!compact)}
        className={cn("inline-flex shrink-0 items-center gap-1 rounded-control px-2 text-meta", wide ? cn("ml-auto h-7", TOUCH_AREA) : "size-11 justify-center", compact ? "bg-sol-text/[0.08] text-sol-text" : "text-sol-text-dim hover:text-sol-text")}
      >
        <Rows3 className="size-3.5" />{wide && " Compact"}
      </button>
    </div>
  );
}
