"use client";
// /priorities/pri-N: one priority's own page, the thing a reference opens and
// Share sends. It is the list's row made bigger: the title (the owner
// double-clicks it to rename), ten days of typing across the page with a date
// under each, the priority's plan once, then its milestones as the list draws
// them (components/priorities/PriorityBlock Milestones) with every open one
// expanded, and the owner's corrections to the pass when there are any. The
// row is the store's (priorityDetails, fed from priorities.show); typing per
// day is an enrichment read beside it, as on the list. The owner's controls
// are the list's (components/priorities/controls): Correct… and ⋯ beside
// Share, each milestone's ⋯, each session's ⋯ in an open milestone, and a
// delete on each correction.
import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Map as MapIcon, PencilLine, Target, X } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory } from "@codecast/shared/contracts/priorities";
import type { PriorityView } from "../../lib/priorityDetail";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { usePriorityDetail, useSyncPriorityDetail } from "../../hooks/usePriorityDetail";
import { linkedPrRefs, linkedSessionIds, usePriorityLookups, usePriorityModel } from "../../hooks/usePriorityModels";
import { useSidebarFocusId } from "../../hooks/useSidebarFocusId";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useSearchParams } from "next/navigation";
import { ShareControl } from "../ShareControl";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame } from "../ui/page-header";
import { pastBadge, priorityHref } from "../../lib/priorities";
import { LIST_DAYS, lastDays, localDayKey } from "../../lib/priorityList";
import { DayStrip } from "./parts";
import { Milestones, PriorityTitleInput } from "./PriorityBlock";
import { CorrectPopover, PriorityMenu } from "./controls";
import { usePriorityWrites } from "../../hooks/usePriorities";

const api = _api as any;

const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const HEAD = "mb-1.5 flex items-baseline gap-2 text-mark font-semibold uppercase tracking-wide text-sol-text-dim";

export default function PriorityPage({ id }: { id: string }) {
  const shortId = id.toLowerCase();
  const feed = useSyncPriorityDetail(shortId);
  const row = usePriorityDetail(shortId);
  let body;
  // A refusal wins over whatever the store held: merged, rewritten, or no longer the viewer's to read.
  if (feed.refused) body = <EmptyState icon={Target} title={`No priority ${shortId} you can see`} />;
  else if (row) body = <PriorityBody row={row} />;
  else if (feed.error) body = <EmptyState icon={AlertTriangle} title="This priority didn't load" action={{ label: "Try again", onClick: feed.retry }} />;
  else body = <SkeletonRows rows={8} className="pt-6" rowClassName="h-8" />;
  return (
    <PageFrame header={null} legacyColumn="mx-auto w-full max-w-[820px] px-4 pb-16 pt-4" column="mx-auto w-full max-w-[820px] px-4 pb-16 pt-4">
      <Link href="/priorities" className="mb-2 inline-flex items-center gap-1 rounded px-1 py-0.5 text-meta [@media(pointer:coarse)]:h-11 text-sol-text-dim no-underline hover:bg-sol-bg-alt hover:text-sol-text">
        <ArrowLeft className="size-3.5" aria-hidden /> Priorities
      </Link>
      {body}
    </PageFrame>
  );
}

function PriorityBody({ row }: { row: PriorityView }) {
  const now = useCoarseNow(30_000);
  // Opened at a milestone (`?milestone=`): that milestone, and the section that holds it, in view.
  const focus = useSearchParams()?.get("milestone") ?? null;
  useMountEffect(() => {
    if (!focus) return;
    document.querySelector(`[data-priority-page] [data-milestone="${focus.replace(/["\\]/g, "\\$&")}"]`)?.scrollIntoView?.({ block: "start" });
  });
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  // Typing per day is computed on read from typed messages: the page paints without it.
  const history = useQueryNoThrow(
    api.priorities.history,
    { workspace: row.workspace, days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() },
    { remember: true },
  ).data as PriorityHistory | undefined;
  const model = usePriorityModel(row, history, days, "sidebar", useSidebarFocusId());
  // The priority's plan shows once, above the milestones; a milestone lists only a plan of its own (Connected).
  const plan = model.plan;
  const linked = useMemo(() => ({ ids: linkedSessionIds([row]), prs: linkedPrRefs([row]) }), [row]);
  const lookups = usePriorityLookups(linked.ids, linked.prs, [row.workspace]);
  const corrections = row.corrections;
  const writes = usePriorityWrites();
  const [renaming, setRenaming] = useState(false);
  const past = row.status !== "active";

  return (
    <article data-priority-page={row.short_id} className="[container-type:inline-size]">
      {/* On a phone the actions take a row of their own above the title, so the title has the whole width. */}
      <header className="flex items-start gap-3 max-sm:flex-col max-sm:gap-1">
        <span className="mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-lg bg-sol-text/[0.06] text-sol-text-muted sm:flex"><Target className="size-[18px]" aria-hidden /></span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 max-sm:self-stretch">
          {renaming ? (
            <PriorityTitleInput row={row} onDone={() => setRenaming(false)} className="text-[22px] font-semibold leading-tight sm:text-[22px]" />
          ) : (
            // The priority's own page shows its title whole; its owner double-clicks it to rename.
            <h1
              data-priority-title
              // The owner's title takes focus back when a rename ends by key.
              data-rename-return={row.mine || undefined}
              tabIndex={row.mine ? -1 : undefined}
              onDoubleClick={row.mine ? () => setRenaming(true) : undefined}
              className="min-w-0 break-words text-[22px] font-semibold leading-tight text-sol-text"
            >
              {row.title}
            </h1>
          )}
          {/* A teammate's priority says whose it is; the viewer's own needs no name. */}
          {!row.mine && row.owner && <span data-priority-owner className="whitespace-nowrap text-meta text-sol-text-dim">{row.owner}</span>}
          {past && <span data-past className="whitespace-nowrap text-meta text-sol-text-dim">{pastBadge(row)}</span>}
        </div>
        <div data-priority-actions className="flex shrink-0 items-center gap-1 max-sm:order-first max-sm:self-end">
          {row.mine && <CorrectButton row={row} />}
          {/* Under a coarse pointer the shared Share trigger takes a 44px press area here. */}
          <ShareControl label="priority" path={priorityHref(row.short_id)} copyId={row.short_id} className="[@media(pointer:coarse)]:[&_[data-share-trigger]]:size-11" />
          <PriorityMenu row={row} onRename={() => setRenaming(true)} />
        </div>
      </header>

      <section data-ten-days className="mt-4">
        <DayStrip counts={model.counts} days={days} todayIndex={todayIndex} peak={Math.max(1, ...model.counts)} pending={!history} page />
      </section>

      {plan && (
        <Link
          href={`/plans/${plan.short_id}`}
          data-priority-plan={plan.short_id}
          className="mt-4 flex min-h-7 min-w-0 items-center gap-2 text-ui text-sol-text decoration-sol-text-dim/50 hover:underline [@media(pointer:coarse)]:min-h-11"
        >
          <MapIcon className="size-3.5 shrink-0 text-sol-text-dim" aria-hidden />
          {/* One line on a wide page under a mouse; two on a phone or a touch screen, as other titles wrap. */}
          <span data-priority-plan-title className="min-w-0 truncate [@container(max-width:40rem)]:line-clamp-2 [@container(max-width:40rem)]:whitespace-normal [@media(pointer:coarse)]:line-clamp-2 [@media(pointer:coarse)]:whitespace-normal">{plan.title}</span>
          <span className="shrink-0 whitespace-nowrap text-meta tabular-nums text-sol-text-dim">{plan.done}/{plan.total}</span>
        </Link>
      )}

      <section data-milestones className="mt-4">
        <Milestones model={model} layout="wide" now={now} lookups={lookups} expand focus={focus} />
      </section>

      {corrections.length > 0 && (
        <section data-corrections className="mt-5">
          <h2 className={HEAD}>Corrections <span className="font-normal normal-case tracking-normal tabular-nums">{corrections.length}</span></h2>
          <ul className="divide-y divide-sol-border/40 rounded-lg border border-sol-border/60">
            {corrections.map((c) => {
              const about = c.step_key ? row.steps.find((s) => s.key === c.step_key)?.title : null;
              return (
                // A phone stacks it: the date, the text across the whole width, then its status and delete.
                <li key={c._id} data-correction={c._id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-ui">
                  <span className="w-14 shrink-0 text-meta tabular-nums text-sol-text-dim max-sm:w-full">{shortDate(c.created_at)}</span>
                  <span data-correction-text className="min-w-0 flex-1 break-words max-sm:basis-full">{about && <span className="text-sol-text-muted">{about}: </span>}<span className="text-sol-text">{c.text}</span></span>
                  <span className="shrink-0 text-meta text-sol-text-dim max-sm:mr-auto">{c.status === "applied" ? "kept by the pass" : "waits for the next pass"}</span>
                  {/* One still on its way deletes by its local id: the server finds it by the client key it was written with. */}
                  {row.mine && (
                    <button
                      type="button"
                      data-delete-correction={c._id}
                      aria-label="Delete this correction"
                      title="Delete: later passes stop reading it"
                      onClick={() => writes.deleteCorrection(c._id)}
                      className="-my-1 flex size-8 shrink-0 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text max-sm:size-11 [@media(pointer:coarse)]:size-11"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}

/** "Correct…" beside Share: what the pass got wrong about the whole priority. */
function CorrectButton({ row }: { row: PriorityView }) {
  const writes = usePriorityWrites();
  const [open, setOpen] = useState(false);
  return (
    <CorrectPopover open={open} onOpenChange={setOpen} subject={row.title} onSave={(text) => writes.correct(row.short_id, text, null)}>
      <button type="button" data-correct-priority onClick={() => setOpen(true)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-2.5 text-meta text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text max-sm:h-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11">
        <PencilLine className="size-3.5" aria-hidden /> <span className="max-sm:sr-only">Correct…</span>
      </button>
    </CorrectPopover>
  );
}
