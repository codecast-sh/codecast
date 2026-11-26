"use client";
// /priorities: the page checked between sessions. One line of stats (critical
// milestones landed in ten days, where today's messages went), the filters
// (Mine, Hide done, which links to Show; kept in the address), what waits on
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
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { usePriorities, usePriorityListMeta, useRunPriorities, useSyncPriorities } from "../../hooks/usePriorities";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/button";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame, PageHeader } from "../ui/page-header";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { behindLabel, nextPassLabel, ownerGroups, passDue, type PriorityRow } from "../../lib/priorities";
import {
  LIST_DAYS, LIST_GRID, SHOW_KINDS, buildModels, filtersHref, landedByDay, lastDays, layoutForWidth, localDayKey, readFilters, todayOf, waitingOf,
  type ListFilters, type ListLayout, type PriorityModel, type ShowKind,
} from "../../lib/priorityList";
import { useInboxStore, type ClientUI } from "../../store/inboxStore";
import { cn } from "../../lib/utils";
import { PriorityBlock } from "./PriorityBlock";
import { linkedSessionIds, usePriorityLiveStates, usePriorityLookups } from "../../hooks/usePriorityModels";
import { StatsLine } from "./StatsLine";
import { WaitingOnYou } from "./Waiting";

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
  const pass = useRunPriorities(rows.length);
  const now = useCoarseNow(30_000);
  const behind = behindLabel(meta.behind_by_ms);

  const router = useRouter();
  const params = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const setFilters = useCallback((f: ListFilters) => router.replace(filtersHref(f, params)), [router, params]);
  const compact = useInboxStore((s) => !!(s.clientState.ui as CompactPrefs | undefined)?.priorities_view?.compact);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const setCompact = useCallback((on: boolean) => updateClientUI({ priorities_view: { compact: on } } as Partial<ClientUI>), [updateClientUI]);
  const [measure, layout] = useListLayout();

  const behindChip = behind ? <BehindChip label={behind} /> : undefined;
  const legacy = <h1 className="flex items-center gap-2 px-4 pt-6 text-title font-semibold text-sol-text">Priorities{behindChip}</h1>;
  const active = rows.filter((r) => r.status === "active").length;

  let body: ReactNode;
  if (rows.length === 0 && feed.error) {
    body = (
      <EmptyState icon={AlertTriangle} title="Priorities didn't load" action={{ label: "Try again", onClick: feed.retry }}>
        <details className="max-w-md text-meta text-sol-text-dim">
          <summary className="cursor-pointer">Details</summary>
          <p className="mt-1 break-words">{feed.error.message}</p>
        </details>
      </EmptyState>
    );
  } else if (rows.length === 0 && !feed.ready) {
    body = <SkeletonRows rows={6} className="pt-2" rowClassName="h-8" />;
  } else if (rows.length === 0) {
    body = <NoPrioritiesYet nextPass={nextPassLabel(meta.next_pass_at, now)} running={pass.running || passDue(meta, now)} onRun={pass.run} />;
  } else {
    body = <PrioritiesView rows={rows} history={history} now={now} layout={layout} filters={filters} onFilters={setFilters} compact={compact} onCompact={setCompact} />;
  }

  return (
    <PageFrame
      header={<PageHeader legacy={legacy} title="Priorities" icon={Target} count={rows.length ? active : null} status={behindChip} />}
      legacyColumn="mx-auto w-full max-w-[1080px]"
      column="mx-auto w-full max-w-[1080px] px-3 pb-16 pt-3 sm:px-4"
    >
      <div ref={measure}>{body}</div>
    </PageFrame>
  );
}

/**
 * The layout for the list's own width (lib/priorityList layoutForWidth),
 * first guessed from the window and then measured, re-rendering only when
 * the layout flips.
 */
function useListLayout(): [(el: HTMLDivElement | null) => void, ListLayout] {
  const [layout, setLayout] = useState<ListLayout>(() => layoutForWidth(typeof window === "undefined" ? 1280 : window.innerWidth));
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => setLayout(layoutForWidth(entry.contentRect.width)));
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
    <Button size="sm" variant="secondary" disabled data-priorities-running>
      <Loader2 className="animate-spin" /> Running
    </Button>
  ) : onRun ? (
    <Button size="sm" variant="primary" onClick={() => setReviewing(true)}>
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

export function PrioritiesView({ rows, history, now, layout, filters, onFilters, compact, onCompact }: {
  rows: PriorityRow[];
  history: PriorityHistory | undefined;
  now: number;
  layout: ListLayout;
  filters: ListFilters;
  onFilters: (f: ListFilters) => void;
  compact: boolean;
  onCompact: (on: boolean) => void;
}) {
  const scoped = useMemo(() => rows.filter((r) => r.status !== "merged" && (!filters.mine || r.mine)), [rows, filters.mine]);
  const visible = useMemo(() => scoped.filter((r) => !filters.hideDone || r.status === "active"), [scoped, filters.hideDone]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(visible), [visible]);
  const live = usePriorityLiveStates(ids, now);
  const models = useMemo(() => buildModels(visible, history, live, days, now), [visible, history, live, days, now]);
  const waiting = useMemo(() => waitingOf(models), [models]);
  const landed = useMemo(() => landedByDay(scoped, days), [scoped, days]);
  const today = useMemo(() => todayOf(history, rows, now), [history, rows, now]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);

  const lookups = usePriorityLookups();

  const groups = ownerGroups(visible);
  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  const block = (m: PriorityModel | undefined) => m && (
    <PriorityBlock key={m.row.short_id} model={m} layout={layout} compact={compact} filters={filters} todayIndex={todayIndex} peak={peak} now={now} lookups={lookups} />
  );
  return (
    <div data-priorities data-layout={layout} data-compact={compact || undefined} className="[container-type:inline-size]">
      <StatsLine days={days} landed={landed} todayIndex={todayIndex} today={today} loose={history?.unassigned_today ?? []} now={now} layout={layout} />
      <FilterBar filters={filters} onChange={onFilters} compact={compact} onCompact={onCompact} layout={layout} />
      {filters.mine && <WaitingOnYou items={waiting} now={now} layout={layout} />}
      {layout === "wide" && (
        <div aria-hidden className={cn(LIST_GRID.wide, "border-b border-sol-border/50 pb-1 text-mark font-medium uppercase tracking-wide text-sol-text-dim")}>
          <span className="col-start-3 justify-self-end">Critical</span>
          <span className="col-start-4 justify-self-center">Today</span>
          <span className="col-start-5">10 days</span>
        </div>
      )}
      {groups.map((g) => (
        <section key={g.user_id} data-owner={g.user_id} className={cn(!filters.mine && "mb-6")}>
          {!filters.mine && <h2 className="mb-1 border-b border-sol-border/60 pb-1.5 pt-2 text-ui font-semibold text-sol-text">{g.mine ? "You" : g.owner || "Teammate"}</h2>}
          <ol>{[...g.active, ...g.past].map((r) => block(byId.get(r.short_id)))}</ol>
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
      className={cn("inline-flex items-center gap-1 rounded-[5px] px-2.5 text-meta transition-colors", tall ? "h-10" : "h-7", on ? "bg-sol-card font-medium text-sol-text shadow-sm" : "text-sol-text-dim hover:text-sol-text")}
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
    <div data-filters className="mb-2 flex items-center gap-3">
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
              className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-meta transition-colors", filters.show[k] ? "border-sol-text-muted/60 text-sol-text" : "border-transparent text-sol-text-dim hover:border-sol-border")}
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
        className={cn("inline-flex shrink-0 items-center gap-1 rounded-control px-2 text-meta", wide ? "ml-auto h-7" : "size-11 justify-center", compact ? "bg-sol-text/[0.08] text-sol-text" : "text-sol-text-dim hover:text-sol-text")}
      >
        <Rows3 className="size-3.5" />{wide && " Compact"}
      </button>
    </div>
  );
}
