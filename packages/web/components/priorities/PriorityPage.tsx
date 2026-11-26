"use client";
// /priorities/pri-N: one priority's own page, the thing a reference opens and
// Share sends. Its rank once with who placed it, ten days of momentum across
// the page (typing per day, the days a critical milestone landed), the one
// next action (the list's rule) and whatever else asks the person, the AI
// summary folded away, every milestone with its chips (each opening in place
// to its sessions and links, as on the list), everything linked, and the
// owner's corrections to the pass when there are any. The row is the store's
// (priorityDetails, fed from priorities.show); typing per day is an
// enrichment read beside it, as on the list. The owner's controls are the
// list's (components/priorities/controls): Correct… and ⋯ beside Share, each
// milestone's box as its Done toggle and its own ⋯, each session's ⋯ in an
// open milestone, and a delete on each correction.
import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ChevronRight, PencilLine, Target, X } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PriorityHistory, PriorityPlanRef } from "@codecast/shared/contracts/priorities";
import type { PriorityView } from "../../lib/priorityDetail";
import { asksPerson } from "@codecast/shared/contracts/priorityDerive";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { usePriorityDetail, useSyncPriorityDetail } from "../../hooks/usePriorityDetail";
import { branchesOf, linkedPrRefs, linkedSessionIds, usePriorityLookups, usePriorityModel, type LinkLookups } from "../../hooks/usePriorityModels";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useSearchParams } from "next/navigation";
import { EntityIdPill } from "../EntityIdPill";
import { ShareControl } from "../ShareControl";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { PageFrame } from "../ui/page-header";
import { pastBadge, priorityHref, rankProvenance } from "../../lib/priorities";
import { LIST_DAYS, TOUCH_AREA, lastDays, lineSession, localDayKey, waitingOf, type MilestoneModel, type PriorityModel, type SessionLine } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { ActionButton, AnswerSecondary, BranchChip, DeployChip, MilestoneMark, PlanChip, PrChip, SessionChip } from "./parts";
import { MilestoneDetail, PendingMark, SessionRow, TypeRow, WorkflowRuns } from "./PriorityBlock";
import { CorrectPopover, LooksDone, MilestoneMenu, MilestoneTitleInput, MilestoneToggle, PriorityMenu } from "./controls";
import { usePriorityWrites } from "../../hooks/usePriorities";
import { CriticalMeter } from "./PriorityRef";
import { WaitingRow } from "./Waiting";

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
  const focus = useSearchParams()?.get("milestone") ?? null;
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  // Typing per day is computed on read from typed messages: the page paints without it.
  const history = useQueryNoThrow(
    api.priorities.history,
    { workspace: row.workspace, days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() },
    { remember: true },
  ).data as PriorityHistory | undefined;
  const model = usePriorityModel(row, history, days);
  const linked = useMemo(() => ({ ids: linkedSessionIds([row]), prs: linkedPrRefs([row]) }), [row]);
  const lookups = usePriorityLookups(linked.ids, linked.prs);
  const { action } = model;
  // Everything else asking the person here, past the one the action answers.
  const waiting = useMemo(() => waitingOf([model]).filter((w) => w.session.conversation_id !== action?.session?.conversation_id).map((w) => ({ ...w, rank: null })), [model, action]);
  const critical = model.milestones.filter((m) => m.tier === "critical");
  const polish = model.milestones.filter((m) => m.tier === "polish");
  const corrections = row.corrections;
  const writes = usePriorityWrites();
  const why = rankProvenance(row);
  const active = row.status === "active";

  return (
    <article data-priority-page={row.short_id} className="[container-type:inline-size]">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 hidden size-8 shrink-0 items-center justify-center rounded-lg bg-sol-text/[0.06] text-sol-text-muted sm:flex"><Target className="size-[18px]" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold leading-tight text-sol-text">{row.title}</h1>
          <div data-priority-meta className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-sol-text-dim">
            {active && row.rank != null ? <span data-rank className="font-semibold tabular-nums text-sol-text">#{row.rank}</span> : <span>{pastBadge(row)}</span>}
            {active && why && <span data-rank-by>{why}</span>}
            <Dot />
            <CriticalMeter done={row.counts.critical_done} total={row.counts.critical_total} />
            {/* "Sarah Chen placed it" already names a teammate who placed it. */}
            {!(active && why && !row.mine && row.rank_source === "person") && <><Dot /><span>{row.mine ? "You" : row.owner}</span></>}
            {row.serves && <><Dot /><span className="whitespace-nowrap"><EntityIdPill shortId={row.serves} type="initiative" compact /></span></>}
            <Dot />
            <span className="whitespace-nowrap">Started {shortDate(row.first_seen_at)}</span>
            <Dot />
            <span className="font-mono">{row.short_id}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {row.mine && <CorrectButton row={row} />}
          {/* Under a coarse pointer the shared Share trigger takes a 44px press area here. */}
          <ShareControl label="priority" path={priorityHref(row.short_id)} className="[@media(pointer:coarse)]:[&_[data-share-trigger]]:size-11" />
          <PriorityMenu row={row} />
        </div>
      </header>

      <TenDays model={model} days={days} todayIndex={todayIndex} />

      {active && row.mine && (action || waiting.length > 0) && (
        <section data-priority-next className="mt-3 rounded-lg border border-sol-border/70 px-3.5 py-2.5">
          {action && (
            <>
              <div className="text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Next</div>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <MilestoneToggle row={row} step={action.milestone.step} className={TOUCH_AREA} />
                <span className="min-w-0 truncate text-body font-medium text-sol-text">{action.milestone.step.title}</span>
              </div>
              <div className="mt-2 flex min-w-0 pl-[22px]"><ActionButton row={row} action={action} /></div>
            </>
          )}
          {waiting.length > 0 && (
            <div data-also-waiting className={cn(action && "mt-2.5 border-t border-sol-border/50 pt-2")}>
              <div className="text-mark font-semibold uppercase tracking-wide text-sol-text-dim">Also waiting on you</div>
              {waiting.map((w) => <WaitingRow key={w.key} item={w} now={now} full />)}
            </div>
          )}
        </section>
      )}

      {row.summary && (
        <details data-ai-summary className="group mt-3 rounded-lg px-1 text-ui text-sol-text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-1 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 shrink-0 text-sol-text-dim transition-transform group-open:rotate-90" aria-hidden />
            <span className="shrink-0 text-mark font-semibold uppercase tracking-wide text-sol-text-dim">AI summary</span>
            <span className="min-w-0 truncate group-open:hidden">{row.summary}</span>
          </summary>
          <p className="max-w-[64ch] pb-1 pl-[22px] leading-relaxed">{row.summary}</p>
        </details>
      )}

      <section data-critical-path className="mt-5">
        <h2 className={HEAD}>Critical path <span className="font-normal normal-case tracking-normal tabular-nums">{critical.filter((m) => m.done).length}/{critical.length}</span></h2>
        <Milestones model={model} list={critical} now={now} lookups={lookups} focus={focus} />
      </section>
      {polish.length > 0 && (
        <section data-polish-list className="mt-5">
          <h2 className={HEAD}>Polish <span className="font-normal normal-case tracking-normal tabular-nums">{polish.filter((m) => m.done).length}/{polish.length}</span></h2>
          <Milestones model={model} list={polish} now={now} lookups={lookups} focus={focus} />
        </section>
      )}

      <Linked model={model} now={now} lookups={lookups} />

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

const Dot = () => <span aria-hidden>·</span>;

/** "Correct…" beside Share: what the pass got wrong about the whole priority. */
function CorrectButton({ row }: { row: PriorityView }) {
  const writes = usePriorityWrites();
  const [open, setOpen] = useState(false);
  return (
    <CorrectPopover open={open} onOpenChange={setOpen} subject={row.title} onSave={(text) => writes.correct(row.short_id, text, null)}>
      <button type="button" data-correct-priority onClick={() => setOpen(true)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-2.5 text-meta text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text max-sm:h-11 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11">
        <PencilLine className="size-3.5" aria-hidden /> <span className="max-sm:hidden">Correct…</span>
      </button>
    </CorrectPopover>
  );
}

/** Ten days across the page: messages per day, the days a critical milestone landed marked, a date under each. */
function TenDays({ model, days, todayIndex }: { model: PriorityModel; days: string[]; todayIndex: number }) {
  const peak = Math.max(1, ...model.counts);
  const today = model.today;
  return (
    <section data-ten-days className="mt-4">
      <div className="flex items-baseline justify-between text-mark font-semibold uppercase tracking-wide text-sol-text-dim">
        <span>Last 10 days · {model.landed10} landed</span>
        <span className="font-normal normal-case tracking-normal tabular-nums">{today ? `${today} ${today === 1 ? "message" : "messages"} today` : "No messages today"}</span>
      </div>
      <div className="mt-1.5 grid h-[46px] items-end gap-1 sm:gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => {
          const c = model.counts[i] ?? 0;
          const h = c ? Math.max(3, Math.round((c / peak) * 36)) : 1;
          return (
            <span key={d} data-day={d} className="flex h-full flex-col items-center justify-end gap-[3px]" title={`${c} messages${model.landed[i] ? " · a critical milestone landed" : ""}`}>
              {model.landed[i] && <i data-landed className="block h-[6px] w-[2px] bg-sol-text" />}
              <i className={cn("block w-full rounded-[2px]", i === todayIndex ? "border-[1.5px] border-sol-green" : c ? "bg-sol-green" : "bg-sol-text/10")} style={{ height: i === todayIndex ? Math.max(6, h) : h }} />
            </span>
          );
        })}
      </div>
      {/* A phone has room for the day of the month alone. */}
      <div className="mt-1 grid gap-1 border-t border-sol-border/60 pt-1 text-center text-mark tabular-nums text-sol-text-dim sm:gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
        {days.map((d, i) => {
          const at = new Date(`${d}T12:00:00`);
          const full = at.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const short = String(at.getDate());
          return (
            <span key={d} className={cn("whitespace-nowrap", i === todayIndex && "font-semibold text-sol-text")}>
              {i === todayIndex ? "Today" : <><span className="sm:hidden">{short}</span><span className="max-sm:hidden">{full}</span></>}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/** A milestone's chips on its row: the priority's action, an Answer for a session that asks, else its best session; then how many more. */
function MilestoneChips({ model, m }: { model: PriorityModel; m: MilestoneModel }) {
  const mine = model.action?.milestone.key === m.key ? model.action : null;
  let shown: SessionLine | undefined;
  let chip = null;
  if (mine) {
    chip = <ActionButton row={model.row} action={mine} />;
    shown = mine.session;
  } else {
    shown = lineSession(model, m);
    if (shown) chip = asksPerson(shown) ? <AnswerSecondary s={shown} /> : <SessionChip s={shown} className="max-w-[16rem]" />;
  }
  const others = m.sessions.filter((s) => s !== shown).length + m.more;
  return (
    <>
      {chip}
      {others > 0 && <span data-more-sessions className="shrink-0 whitespace-nowrap text-meta tabular-nums text-sol-text-dim">+{others} {others === 1 ? "session" : "sessions"}</span>}
    </>
  );
}

/** Every milestone with its chips; a row opens in place to its sessions and links, as on the list. */
function Milestones({ model, list, now, lookups, focus }: { model: PriorityModel; list: MilestoneModel[]; now: number; lookups: LinkLookups; focus: string | null }) {
  // Opened at a milestone (`?milestone=`, the list's "+N older sessions"): that row open and in view.
  const [openKey, setOpenKey] = useState<string | null>(() => (focus && list.some((m) => m.key === focus) ? focus : null));
  useMountEffect(() => {
    if (!openKey) return;
    document.querySelector(`[data-priority-page] [data-milestone="${openKey.replace(/["\\]/g, "\\$&")}"]`)?.scrollIntoView?.({ block: "start" });
  });
  return (
    <ul className="divide-y divide-sol-border/40 rounded-lg border border-sol-border/60">
      {list.map((m) => (
        <MilestoneRow key={m.key} model={model} m={m} open={openKey === m.key} onToggle={() => setOpenKey((k) => (k === m.key ? null : m.key))} now={now} lookups={lookups} />
      ))}
    </ul>
  );
}

function MilestoneRow({ model, m, open, onToggle, now, lookups }: { model: PriorityModel; m: MilestoneModel; open: boolean; onToggle: () => void; now: number; lookups: LinkLookups }) {
  const { row } = model;
  const writes = usePriorityWrites();
  const [renaming, setRenaming] = useState(false);
  return (
    <li data-milestone={m.key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter") onToggle(); }}
        className={cn("group/line flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-1.5 hover:bg-sol-bg-alt/50", open && "bg-sol-bg-alt/50")}
      >
        {/* A done row keeps its ⋯ on its line: its title wraps instead. */}
        <span className={cn("flex flex-1 items-center gap-2.5", m.done ? "min-w-0" : "min-w-[12rem]")}>
          {/* The owner's box takes the row's left edge as its press area, 44px tall. */}
          {row.mine ? <MilestoneToggle row={row} step={m.step} className={cn("-my-1.5 -ml-3 h-11 pl-3 pr-1", TOUCH_AREA)} /> : <MilestoneMark done={m.done} />}
          {/* On a phone the marks go on a line of their own under the title, as on the list. */}
          <span className="flex min-w-0 flex-1 items-center gap-2.5 max-sm:flex-col max-sm:items-start max-sm:gap-0.5">
            {renaming
              ? <MilestoneTitleInput title={m.step.title} onDone={(next) => { setRenaming(false); if (next) writes.renameStep(row.short_id, m.key, next); }} />
              : <span data-milestone-title className={cn("min-w-0 text-ui", m.done ? "text-sol-text-muted" : "text-sol-text")}>{m.step.title}</span>}
            {(m.looksDone || m.correctionPending) && (
              <span data-milestone-marks className="flex flex-wrap items-center gap-2">
                {m.looksDone && <LooksDone row={row} step={m.step} />}
                {m.correctionPending && <PendingMark />}
              </span>
            )}
          </span>
        </span>
        {m.done ? (
          <span className="ml-auto shrink-0 text-meta tabular-nums text-sol-text-dim">{m.step.done_at ? `Landed ${shortDate(m.step.done_at)}` : "Done"}</span>
        ) : (
          // On a phone every row's action starts at one x, under its title, on a line of its own below the ⋯.
          <span data-line-chips className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5 max-sm:order-last max-sm:ml-[24px] max-sm:basis-[calc(100%-24px)] max-sm:justify-start"><MilestoneChips model={model} m={m} /></span>
        )}
        {row.mine && <MilestoneMenu row={row} step={m.step} onRename={() => setRenaming(true)} reveal="group-hover/line:opacity-100" />}
      </div>
      {open && <div className="px-3 pb-2"><MilestoneDetail model={model} m={m} now={now} lookups={lookups} /></div>}
    </li>
  );
}

/** Everything linked across the milestones, once each: sessions (people's first, workflow runs folded), the plan, PRs, branches, deploys. */
function Linked({ model, now, lookups }: { model: PriorityModel; now: number; lookups: LinkLookups }) {
  const once = <T,>(items: T[], key: (x: T) => string) => [...new Map(items.map((x) => [key(x), x])).values()];
  const sessions = once(model.milestones.flatMap((m) => m.sessions), (s) => s.conversation_id);
  const people = sessions.filter((s) => !s.workflow);
  const runs = sessions.filter((s) => s.workflow);
  const plans: Array<{ plan: PriorityPlanRef; prefix?: string }> = once(
    [
      ...(model.plan ? [{ plan: model.plan }] : []),
      ...model.milestones.flatMap((m) => (m.plan ? [{ plan: m.plan }] : [])),
      ...model.milestones.flatMap((m) => m.partOf.map((plan) => ({ plan, prefix: "Part of" }))),
    ],
    (p) => p.plan.short_id,
  );
  const prs = once(model.milestones.flatMap((m) => m.prs), (p) => p);
  const branches = once(model.milestones.flatMap((m) => branchesOf(m, lookups)), (b) => b);
  const deploys = once(model.milestones.flatMap((m) => lookups.deploysOf(m)), (d) => d.id);
  if (!sessions.length && !plans.length && !prs.length && !branches.length && !deploys.length) return null;
  return (
    <section data-linked className="mt-5">
      <h2 className={HEAD}>Linked</h2>
      {sessions.length > 0 && (
        <TypeRow label={`Sessions · ${sessions.length}`}>
          <div className="min-w-0 flex-1">
            {people.length > 0 && <ul>{people.map((s) => <SessionRow key={s.conversation_id} s={s} now={now} />)}</ul>}
            <WorkflowRuns runs={runs} now={now} />
          </div>
        </TypeRow>
      )}
      {plans.length > 0 && <TypeRow label="Plan">{plans.map(({ plan, prefix }) => <PlanChip key={plan.short_id} plan={plan} prefix={prefix} showSize={!!prefix} className="max-w-[24rem]" />)}</TypeRow>}
      {prs.length > 0 && <TypeRow label="PRs">{prs.map((p) => <PrChip key={p} pr={p} state={lookups.prState(p)} />)}</TypeRow>}
      {branches.length > 0 && <TypeRow label="Branches">{branches.map((b) => <BranchChip key={b} name={b} />)}</TypeRow>}
      {deploys.length > 0 && <TypeRow label="Deploys">{deploys.map((d) => <DeployChip key={d.id} d={d} now={now} />)}</TypeRow>}
    </section>
  );
}
