// The timeline tab's rows: each transition with its outcome, and the panel
// an open row shows.
import Link from "next/link";
import { Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsReplays } from "../../hooks/useSyncOps";
import { GroupFixSlots, TaskChip } from "./OpsHomeRow";
import { issueWorkItem } from "./sourceViewModel";
import { IssueActs, ReplayMoment, RowTime } from "./TimelineOccurrences";
import type { AttentionTask } from "./opsHomeModel";
import { fmtStamp, nearestReplay, splitLevel } from "./timelineModel";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { EntityIdPill } from "../EntityIdPill";
import { eventSourceName, isReleaseMarker } from "./opsModel";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import type { OpsEvent, OpsGroup, OpsSource } from "./opsTypes";
import { kindLabel, PAGE_ROWS, statusInk, statusWord } from "./timelineTabModel";

// ── Rows ──

export function Rows(p: {
  events: OpsEvent[];
  span: number;
  /** The window needs dates on its times (windowDated). */
  dated?: boolean;
  groupOf: Map<string, OpsGroup>;
  providerOf: Map<string, OpsSource["provider"]>;
  open: string | null;
  cursor: string | null;
  setOpen: (id: string | null) => void;
  live: boolean;
  canOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  reachedStart: boolean;
  filtered: boolean;
  clear: () => void;
  widen: () => void;
  source: string | null;
  taskOf: (id: string) => AttentionTask | undefined;
}) {
  const [limit, setLimit] = useState(PAGE_ROWS);
  const rowNow = useCoarseNow(60_000);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // "N new": rows that arrived while the reader was scrolled away from the top.
  const [anchor, setAnchor] = useState<number | null>(null);
  const newest = p.events[0]?.created_at ?? 0;
  const fresh = anchor != null ? p.events.filter((e) => e.created_at > anchor).length : 0;
  useWatchEffect(() => {
    const scroller = list.current?.closest(".ops-body") as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => setAnchor((a) => (scroller.scrollTop > 240 ? a ?? newest : null));
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [newest]);
  // More rows as the end comes into view: the next screenful, then the server's next page.
  useWatchEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      if (limit < p.events.length) setLimit((l) => l + PAGE_ROWS);
      else if (p.canOlder) p.loadOlder();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, p.events.length, p.canOlder]);

  if (!p.events.length) {
    return (
      <div className="otl-empty" data-ops-stream-empty>
        <b>{p.filtered ? "Nothing matches" : p.source ? `Nothing from ${p.source} in this window` : "Nothing in this window"}</b>
        <span className="otl-empty-acts">
          {p.filtered && <button type="button" className="ops-btn" onClick={p.clear}>Clear the filter</button>}
          <button type="button" className="ops-btn" onClick={p.widen}>Last 30 days</button>
          {p.canOlder && <button type="button" className="ops-btn" onClick={p.loadOlder}>Load older</button>}
        </span>
      </div>
    );
  }
  return (
    <section className="otl-rows" ref={list} aria-label="Events" data-span={p.span > 2 * 86_400_000 || p.dated ? "long" : undefined}>
      {fresh > 0 && (
        <button type="button" className="otl-fresh" onClick={() => { (list.current?.closest(".ops-body") as HTMLElement | null)?.scrollTo({ top: 0, behavior: "smooth" }); setAnchor(null); }}>
          {fresh} new
        </button>
      )}
      <div className="otl-row otl-row-head" aria-hidden>
        <span>Time</span><span>Source</span><span>What</span><span>Title</span><span>Issue</span><span>Codecast</span>
      </div>
      {p.events.slice(0, limit).map((e) => (
        <Row key={e._id} e={e} span={p.span} dated={p.dated} now={rowNow} group={e.data?.group_short_id ? p.groupOf.get(e.data.group_short_id) : undefined} taskOf={p.taskOf} provider={p.providerOf.get(eventSourceName(e))} on={p.open === e._id} cursor={p.cursor === e._id} onOpen={() => p.setOpen(p.open === e._id ? null : e._id)} />
      ))}
      <div ref={sentinel} className="otl-sentinel">
        {limit < p.events.length ? (
          <button type="button" className="ops-btn" onClick={() => setLimit((l) => l + PAGE_ROWS)}>Show {Math.min(PAGE_ROWS, p.events.length - limit)} more</button>
        ) : p.loadingOlder ? (
          <span className="ops-dim">Reading older events…</span>
        ) : p.canOlder ? (
          <button type="button" className="ops-btn" onClick={p.loadOlder}>Load older</button>
        ) : (
          <span className="ops-dim">{p.reachedStart ? "The start of this source's stream" : `${p.events.length.toLocaleString()} events`}</span>
        )}
      </div>
    </section>
  );
}

/**
 * What codecast did about it: the task it filed (its ct- id, state and who
 * has it), a live dot for the session fixing it, the deploy that carried it;
 * on an open issue nobody is on, Fix.
 */
function Outcome({ e, group, task }: { e: OpsEvent; group?: OpsGroup; task?: AttentionTask }) {
  const out: ReactNode[] = [];
  if (e.meta?.deploy) out.push(<EntityIdPill key="dp" shortId={e.meta.deploy} type="deploy" compact />);
  if (group?.signal_task_id) out.push(<TaskChip key="task" taskId={group.signal_task_id} task={task ?? null} />);
  // An open issue's fix session is its fix plan's press below (open, continue); a settled one keeps the link to the session that fixed it.
  if (group?.fix_conversation_id && group.status !== "open") out.push(<Link key="fix" href={`/conversation/${group.fix_conversation_id}`} className="otl-live-fix" title="The session that fixed it" data-ops-fixing><i aria-hidden />fixed</Link>);
  if (!out.length && group?.status === "resolved") out.push(<span key="res" className="otl-pill" data-tone="ok">resolved{group.resolved_in ? ` in ${group.resolved_in}` : ""}</span>);
  if (!out.length && group?.status === "ignored") out.push(<span key="ign" className="otl-pill">ignored</span>);
  if (group?.status === "open") {
    // The same fix plan and words as the issue's row on the Ops home, its overview and its Fix card.
    out.push(<span key="start" className="otl-fix"><GroupFixSlots item={issueWorkItem(group, task)} group={group} bare /></span>);
  }
  return <span className="otl-outcome ops-ref-fit">{out}</span>;
}

/** The Codecast column folded into the Issue cell where the column has no room: one dot for tracked, fixing, or nobody on it. */
function issueState(group: OpsGroup | undefined): "fixing" | "tracked" | "open" | null {
  if (!group) return null;
  if (group.fix_conversation_id) return "fixing";
  if (group.signal_task_id) return "tracked";
  return group.status === "open" ? "open" : null;
}

function Row({ e, span, dated, now, group, taskOf, provider, on, cursor, onOpen }: { e: OpsEvent; span: number; dated?: boolean; now: number; group?: OpsGroup; taskOf: (id: string) => AttentionTask | undefined; provider?: OpsSource["provider"]; on: boolean; cursor: boolean; onOpen: () => void }) {
  const st = e.data?.transition ?? e.kind;
  const kind = isReleaseMarker(e) ? "deploy" : e.data?.group_kind;
  const { level, type } = splitLevel(e.data?.level);
  const state = issueState(group);
  // "error error": a level that repeats the kind says nothing twice.
  const showKind = kind && kind !== "deploy" && kind !== level;
  return (
    <div className="otl-row" data-on={on ? "true" : undefined} data-cursor={cursor ? "true" : undefined} data-ops-row={e._id} data-ops-event={e._id} role="button" tabIndex={0} aria-expanded={on} onClick={(ev) => { if (ev.currentTarget.contains(ev.target as Node) && !(ev.target as Element).closest("a, button")) onOpen(); }} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onOpen(); } }}>
      <RowTime at={e.created_at} span={span} now={now} dated={dated} />
      <span className="otl-src">{provider && <ProviderIcon provider={provider} />}<span className="truncate">{eventSourceName(e)}</span></span>
      <span className="otl-what">
        <span className="otl-st" style={{ color: statusInk(st), background: `color-mix(in srgb, ${statusInk(st)} 12%, transparent)` }}>{statusWord(st)}</span>
        {showKind && <span className="otl-kind">{kindLabel(kind)}</span>}
        {level && <span className="otl-level" data-level={level}>{level}</span>}
        {type && <span className="otl-kind">{type.replace(/_/g, " ")}</span>}
      </span>
      <span className="otl-title truncate" title={e.title}>{e.title}{e.data?.count && e.data.count > 1 ? <span className="ops-dim ops-num"> ×{e.data.count.toLocaleString()}</span> : null}</span>
      <span className="otl-id ops-mono">{e.data?.group_short_id ? <Link href={opsHref.issue(e.data.group_short_id)}>{state && <i className="otl-id-dot" data-state={state} title={state === "fixing" ? "A session is fixing it" : state === "tracked" ? "Tracked in a task" : "Nobody is on it"} aria-hidden />}{e.data.group_short_id}</Link> : e.meta?.deploy ? null : <span className="ops-dim">-</span>}</span>
      <Outcome e={e} group={group} task={group?.signal_task_id ? taskOf(group.signal_task_id) : undefined} />
    </div>
  );
}

// ── The side panel ──

export function EventPanel({ event: e, group, provider, taskOf, onClose }: { event: OpsEvent; group?: OpsGroup; provider?: OpsSource["provider"]; taskOf: (id: string) => AttentionTask | undefined; onClose: () => void }) {
  const replays = useOpsReplays();
  // A replay issue's event plays where it happened: the recording that showed it nearest the event, at that second.
  const replay = useMemo(() => (group ? nearestReplay(replays, group._id, e.created_at) : null), [replays, group, e.created_at]);
  const task = group?.signal_task_id ? taskOf(group.signal_task_id) : undefined;
  useWatchEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const st = e.data?.transition ?? e.kind;
  const d = e.data ?? {};
  const facts: [string, ReactNode][] = [
    ["When", fmtStamp(e.created_at)],
    ["Source", <span key="s" className="inline-flex items-center gap-1.5">{provider && <ProviderIcon provider={provider} />}{eventSourceName(e)}</span>],
    ["Status", statusWord(st)],
    ...(d.group_kind ? [["Kind", kindLabel(d.group_kind)] as [string, ReactNode]] : []),
    ...(d.level ? [["Level", d.level] as [string, ReactNode]] : []),
    ...(d.count != null ? [["Count", d.count.toLocaleString()] as [string, ReactNode]] : []),
    ...(d.value != null ? [["Value", `${d.value}${d.threshold != null ? ` (line ${d.threshold})` : ""}`] as [string, ReactNode]] : []),
    ...(d.release ? [["Release", <span key="r" className="ops-mono">{d.release}</span>] as [string, ReactNode]] : []),
    ...(d.environment ? [["Env", d.environment] as [string, ReactNode]] : []),
    ...(e.sha ? [["Commit", <span key="c" className="ops-mono">{e.sha.slice(0, 10)}</span>] as [string, ReactNode]] : []),
  ];
  return (
    <aside className="otl-panel" aria-label="Event" data-ops-event-panel>
      <div className="otl-panel-head">
        <span className="otl-st" style={{ color: statusInk(st), background: `color-mix(in srgb, ${statusInk(st)} 12%, transparent)` }}>{statusWord(st)}</span>
        <span className="flex-1" />
        <button type="button" className="otl-clear" aria-label="Close" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="otl-panel-title">{e.title}</div>
      <dl className="ops-kv">
        {facts.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
      </dl>
      {replay && <ReplayMoment replayRef={replay.short_id || replay._id} at={Math.max(replay.started_at, Math.min(e.created_at, replay.started_at + (replay.duration_ms ?? 0)))} />}
      {group && (
        <div className="otl-panel-group">
          <div className="ops-section-label">Issue</div>
          <Link href={opsHref.issue(group.short_id)} className="otl-panel-issue">
            <span className="ops-mono">{group.short_id}</span>
            <span className="truncate">{group.title}</span>
            <span className="ops-dim ops-num">{group.count.toLocaleString()}×</span>
          </Link>
          <div className="otl-panel-facts ops-dim ops-num">
            first {fmtStamp(group.first_seen)} · last {fmtStamp(group.last_seen)}
          </div>
          <IssueActs group={group} task={task} />
        </div>
      )}
      {e.meta?.deploy && (
        <div className="otl-panel-group">
          <div className="ops-section-label">Deploy</div>
          <EntityIdPill shortId={e.meta.deploy} type="deploy" />
        </div>
      )}
      {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="ops-btn self-start">Open at the source<ExternalLink className="w-3 h-3" /></a>}
    </aside>
  );
}

// ── Keys ──
