"use client";
// The Timeline view (ct-68152): everything that entered the workspace's line,
// newest first, at the volume a team's line takes in a day. Each row says what
// happened, where it came from and when, and what it became; one opens beside
// the list with where it came from down to the raw thing (OriginTrail) and
// where it went. Filters: what kind of thing, where from, and the header's
// project filter. Rows are virtualized; the feed is polled and paged
// (useSyncLineTimeline), so the list says how far back it is complete.
import { memo, useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import type { LineViewProps } from "../types";
import { useSyncLineTimeline } from "../../../../../hooks/useSyncLineTimeline";
import { useWorkspaceCollection } from "../../../../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../../../../hooks/useCollectionRows";
import { useCoarseNow } from "../../../../../hooks/useCoarseNow";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import {
  GROUP_LABELS, GROUP_OF, TIMELINE_GROUPS, becameOf, decisionEvents, findingIndex, groupCounts, kindWords, sourceWords, timelineRows, timelineSources,
  type ChainIndex, type ChainStep, type TimelineDecision, type TimelineEvent, type TimelineGroup,
} from "../../../../../lib/line/lineTimeline";
import { opsHref } from "../../../../ops/opsPaths";
import { entityRoute } from "@codecast/shared/entities";
import { OriginTrail } from "../../../widgets/OriginTrail";
import { useLineNav } from "../../../widgets/parts";
import "./timelineView.css";

const ROW_H = 34;
const DAY_H = 30;
/** Events read on open to reach the start of today; past it, scrolling reads further. */
const TODAY_CAP = 4000;

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayName = (at: number, now: number) => {
  const d = new Date(at), today = new Date(now);
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const csv = (v: string | null) => (v ? new Set(v.split(",").filter(Boolean)) : null);

type ListRow = { kind: "day"; key: string; label: string; n: number } | { kind: "event"; key: string; e: TimelineEvent };

export function TimelineView({ workspace: ws, selection, select, href, space }: LineViewProps) {
  const now = useCoarseNow(60_000);
  const feed = useSyncLineTimeline(space ?? null);
  const stored = useWorkspaceCollection<TimelineEvent>("lineTimeline", (e) => `${e.detail ?? ""}|${e.task ?? ""}`, feed.workspace);
  const decisions = useCollectionRows<TimelineDecision>("sessionDecisions", { sig: (d) => `${d.status}|${d.resolved_at ?? 0}|${d.task_id ?? ""}` });

  // Problems by id, as the line holds them: ref, state, the problem a merge folded it into.
  const tasks = useMemo(() => {
    const byId = new Map<string, { short_id?: string; status: string; merged_into_ref?: string; watch_until?: number }>();
    const all = ws.rows.tasks as unknown as Array<{ _id: string; short_id?: string; status: string; duplicate_of?: string; watch_until?: number; cause?: { merged_into?: string } }>;
    const refOf = new Map(all.map((t) => [t._id, t.short_id]));
    for (const t of all) byId.set(t._id, { short_id: t.short_id, status: t.status, merged_into_ref: t.cause?.merged_into ? refOf.get(t.cause.merged_into) ?? t.duplicate_of : t.duplicate_of, watch_until: t.watch_until });
    return byId;
  }, [ws.rows.tasks]);

  const events = useMemo(() => {
    const out: TimelineEvent[] = [...stored];
    const key = feed.workspace ?? "";
    for (const d of decisions) out.push(...decisionEvents(d, key, (id) => tasks.get(id)?.short_id));
    return out;
  }, [stored, decisions, tasks, feed.workspace]);

  const index: ChainIndex = useMemo(() => {
    const runOf = new Map<string, { _id: string; status: string; created_at: number }>();
    for (const r of ws.rows.runs as unknown as Array<{ _id: string; task_id?: string; status: string; created_at: number }>) {
      if (!r.task_id) continue;
      const had = runOf.get(r.task_id);
      if (!had || had.created_at < r.created_at) runOf.set(r.task_id, r);
    }
    const decisionOf = new Map<string, { _id: string; short_id?: string; status: string; created_at: number }>();
    for (const d of decisions) {
      if (!d.task_id || !d.workflow_run_id) continue;
      const had = decisionOf.get(d.task_id);
      if (!had || had.created_at < d.created_at) decisionOf.set(d.task_id, d);
    }
    const deployOf = new Map<string, { short_id?: string; status: string }>();
    // Deploys are newest first: the first that carried a problem is its newest.
    for (const d of ws.deploys) for (const c of d.carries ?? []) if (c.task_id && !deployOf.has(c.task_id)) deployOf.set(c.task_id, { short_id: d.short_id, status: d.status });
    const { byMoment, byGroup } = findingIndex(events);
    return { tasks, runOf, decisionOf, deployOf, findingsOfMoment: byMoment, findingsOfGroup: byGroup };
  }, [ws.rows.runs, ws.deploys, decisions, events, tasks]);

  const groups = csv(selection.kind) as Set<TimelineGroup> | null;
  const sources = csv(selection.source);
  const stations = selection.show === "steps";
  const projectId = ws.project?._id ?? null;
  const rows = useMemo(() => timelineRows(events, { groups, sources, project: projectId, floor: feed.floor, stations }), [events, selection.kind, selection.source, projectId, feed.floor, stations]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => groupCounts(events, feed.floor), [events, feed.floor]);
  const sourceList = useMemo(() => timelineSources(events, feed.floor), [events, feed.floor]);

  const list: ListRow[] = useMemo(() => {
    const out: ListRow[] = [];
    let day = "";
    let head: { kind: "day"; key: string; label: string; n: number } | null = null;
    for (const e of rows) {
      const label = dayName(e.at, now);
      if (label !== day) { day = label; head = { kind: "day", key: `day:${label}`, label, n: 0 }; out.push(head); }
      head!.n++;
      out.push({ kind: "event", key: e._id, e });
    }
    return out;
  }, [rows, now]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (list[i]?.kind === "day" ? DAY_H : ROW_H),
    getItemKey: (i) => list[i]?.key ?? i,
    overscan: 16,
  });
  const items = virtualizer.getVirtualItems();
  const last = items[items.length - 1]?.index ?? 0;
  // On open, read back to the start of today (what came in today is the view's first question), within a cap.
  const today = new Date(new Date(now).toDateString()).getTime();
  useWatchEffect(() => {
    if (feed.floor != null && feed.floor > today && !feed.loading && !feed.done && stored.length < TODAY_CAP) feed.loadOlder();
  }, [feed.floor, feed.loading, feed.done, today, stored.length, feed.loadOlder]);
  // Near the end of what is loaded: read the next page.
  useWatchEffect(() => { if (list.length && last >= list.length - 20) feed.loadOlder(); }, [last, list.length, feed.loadOlder]);

  const toggle = useCallback((key: "kind" | "source", set: Set<string> | null, v: string) => {
    const next = new Set(set ?? []);
    if (next.has(v)) next.delete(v); else next.add(v);
    select({ [key]: next.size ? [...next].join(",") : null }, undefined, { replace: true });
  }, [select]);

  const open = selection.item ? events.find((e) => e._id === selection.item) ?? null : null;

  return (
    <div className="tlv" data-line-timeline data-open={open ? "" : undefined}>
      <div className="tlv-list">
        <div className="tlv-bar" role="toolbar" aria-label="Show">
          {TIMELINE_GROUPS.map((g) => (
            <button key={g} type="button" className="tlv-f" aria-pressed={!!groups?.has(g)} data-group={g} onClick={() => toggle("kind", groups, g)} data-timeline-group={g}>
              <span>{GROUP_LABELS[g]}</span><span className="tlv-n">{counts[g]}</span>
            </button>
          ))}
          <button type="button" className="tlv-f" aria-pressed={stations} onClick={() => select({ show: stations ? null : "steps" }, undefined, { replace: true })} data-timeline-steps>Run steps</button>
        </div>
        {sourceList.length > 1 && (
          <div className="tlv-bar tlv-sources" role="toolbar" aria-label="From">
            {sourceList.slice(0, 12).map((s) => (
              <button key={s.source} type="button" className="tlv-f tlv-src" aria-pressed={!!sources?.has(s.source)} onClick={() => toggle("source", sources, s.source)} data-timeline-source={s.source}>
                <span>{s.label}</span><span className="tlv-n">{s.n}</span>
              </button>
            ))}
          </div>
        )}
        <div className="tlv-scroll" ref={scrollRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vi) => {
              const r = list[vi.index];
              return (
                <div key={vi.key} className="tlv-vrow" style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}>
                  {r.kind === "day"
                    ? <div className="tlv-day"><span>{r.label}</span><span className="tlv-n">{r.n}</span></div>
                    : <EventRow e={r.e} index={index} now={now} active={r.e._id === selection.item} href={href({ item: r.e._id })} onOpen={() => select({ item: r.e._id === selection.item ? null : r.e._id })} />}
                </div>
              );
            })}
          </div>
          <div className="tlv-foot" data-timeline-floor={feed.floor ?? ""}>
            {feed.floor == null ? "Loading…" : feed.done ? "Start of the line's record" : feed.loading ? "Loading older…" : `Complete since ${dayName(feed.floor, now).toLowerCase()} ${clock(feed.floor)}`}
            {!feed.done && feed.floor != null && !feed.loading && <button type="button" className="tlv-older" onClick={feed.loadOlder}>Older</button>}
          </div>
        </div>
      </div>
      {open && <div className="tlv-reader"><EventReader e={open} index={index} now={now} /></div>}
    </div>
  );
}

const EventRow = memo(function EventRow({ e, index, now, active, href, onOpen }: { e: TimelineEvent; index: ChainIndex; now: number; active: boolean; href: string; onOpen: () => void }) {
  const became = becameOf(e, index, now);
  const tail = became[became.length - 1];
  return (
    <a href={href} className="tlv-row" aria-current={active || undefined} data-group={GROUP_OF[e.kind]} data-kind={e.kind} data-timeline-event={e._id}
      onClick={(ev) => { if (!ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); onOpen(); } }}>
      <span className="tlv-t">{clock(e.at)}</span>
      <span className="tlv-k">{kindWords(e)}</span>
      <span className="tlv-title">{e.kind === "station" && e.node ? `${e.node}: ` : ""}{e.title}</span>
      <span className="tlv-from">{sourceWords(e)}</span>
      <span className="tlv-to">{tail ? <StepChip s={tail} /> : e.detail && e.kind !== "moment" && e.kind !== "decision_closed" ? <span className="tlv-detail">{e.detail}</span> : null}</span>
    </a>
  );
});

function stepWords(s: ChainStep): string {
  switch (s.kind) {
    case "finding": return s.ref;
    case "problem": return `${s.ref} ${s.state}`;
    case "run": return `run ${s.state}`;
    case "decision": return `${s.ref ?? "card"} ${s.state}`;
    case "deploy": return `${s.ref} ${s.state}`;
  }
}

function StepChip({ s }: { s: ChainStep }) {
  return <span className="tlv-step" data-step={s.kind} data-state={"state" in s ? s.state : undefined}>{stepWords(s)}</span>;
}

/** One event opened: what it is, where it came from down to the raw thing, and what it became, each a link. */
function EventReader({ e, index, now }: { e: TimelineEvent; index: ChainIndex; now: number }) {
  const nav = useLineNav();
  const became = becameOf(e, index, now);
  const stepHref = (s: ChainStep): string | null => {
    if (s.kind === "problem") return s.id ? nav.caseHref?.(s.id) ?? null : null;
    if (s.kind === "run") return nav.runHref(s.id, null);
    if (s.kind === "decision") return entityRoute("decision", s.ref ?? s.id);
    if (s.kind === "deploy") return entityRoute("deploy", s.ref);
    return null;
  };
  return (
    <article className="tlv-ev" data-timeline-reader={e._id}>
      <header className="tlv-ev-h">
        <span className="tlv-k" data-group={GROUP_OF[e.kind]}>{kindWords(e)}</span>
        <span className="tlv-from">{sourceWords(e)}</span>
        <time className="tlv-t">{dayName(e.at, now)} {clock(e.at)}</time>
      </header>
      <h2 className="tlv-ev-title">{e.title}</h2>
      {e.detail && <div className="tlv-detail">{e.detail}</div>}
      <section className="tlv-sec">
        <h3>Came from</h3>
        <Origin e={e} />
      </section>
      {became.length > 0 && (
        <section className="tlv-sec">
          <h3>Became</h3>
          <ol className="tlv-chain">
            {became.map((s, i) => {
              const to = stepHref(s);
              return <li key={i}>{i > 0 && <span className="ot-arrow" aria-hidden>→</span>}{to ? <Link href={to} className="tlv-chain-a"><StepChip s={s} /></Link> : <StepChip s={s} />}</li>;
            })}
          </ol>
        </section>
      )}
    </article>
  );
}

/** Where an event came from: the trail to the raw thing, or the raw thing's own page when it is not a finding's. */
function Origin({ e }: { e: TimelineEvent }) {
  if (e.kind === "decision_asked" || e.kind === "decision_answered" || e.kind === "decision_closed") return <OriginTrail decision={e.decision} />;
  if (e.kind === "finding") return <OriginTrail signal={e.signal} task={e.task} />;
  if (e.task) return <OriginTrail task={e.task} folded={e.kind !== "problem_opened"} />;
  if (e.moment) return <OriginTrail moment={e.moment} />;
  if (e.group) return <Link className="tlv-chain-a" href={opsHref.issue(e.group)}><span className="tlv-step">{e.group} in Ops</span></Link>;
  if (e.replay) return <Link className="tlv-chain-a" href={opsHref.replay(e.replay)}><span className="tlv-step">{e.replay} replay</span></Link>;
  if (e.deploy) return <Link className="tlv-chain-a" href={entityRoute("deploy", e.deploy) ?? "#"}><span className="tlv-step">{e.deploy}</span></Link>;
  return <span className="tlv-detail">{sourceWords(e)}</span>;
}
